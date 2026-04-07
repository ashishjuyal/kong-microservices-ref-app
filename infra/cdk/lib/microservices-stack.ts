import * as cdk            from 'aws-cdk-lib';
import * as ec2            from 'aws-cdk-lib/aws-ec2';
import * as ecs            from 'aws-cdk-lib/aws-ecs';
import * as ecr            from 'aws-cdk-lib/aws-ecr';
import * as elbv2          from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam            from 'aws-cdk-lib/aws-iam';
import * as logs           from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudmap       from 'aws-cdk-lib/aws-servicediscovery';
import * as apigwv2        from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations   from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct }       from 'constructs';

// =============================================================================
// Context variables — pass at deploy time:
//   cdk deploy -c imageTag=abc12345 -c desiredCount=1
//
//   imageTag     ECR image tag to run.  Default: 'latest'
//                setup-aws-infra.sh passes 'latest' with desiredCount=0 so no
//                tasks start before real images exist in ECR.
//   desiredCount Number of running tasks per app service.  Default: 1
//                Set to 0 during initial infra provisioning.
//
// COST BREAKDOWN (us-east-1, approximate)
// ─────────────────────────────────────────────────────────────────────────────
//   NAT Gateway      $0.045/h  ← ELIMINATED (tasks in public subnets)
//   EFS              per GB    ← ELIMINATED (ephemeral postgres, ideal for demo)
//   Internal ALB     $0.008/h  ← needed for API Gateway VPC Link path routing
//   Fargate (4 tasks) ~$0.08/h (0.5 vCPU / 1 GB each)
//   API Gateway       ~$0/h    (pay-per-request, negligible for demos)
//
//   Estimated total: ~$0.09/h  (~$2.20/day)
//   Destroy with:    cd infra/cdk && npx cdk destroy --force
// =============================================================================

export class MicroservicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imageTag     = (this.node.tryGetContext('imageTag')     ?? 'latest') as string;
    const desiredCount = Number(this.node.tryGetContext('desiredCount') ?? 1);

    // =========================================================================
    // 1. VPC — public subnets only, no NAT Gateway
    //
    // Fargate tasks are placed in public subnets with assignPublicIp=true.
    // They reach ECR, CloudWatch, and Secrets Manager directly via the
    // Internet Gateway (free) — no NAT Gateway ($0.045/h) required.
    //
    // Inbound security is enforced entirely by security groups: ECS tasks only
    // accept traffic from the ALB security group.
    // =========================================================================
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName:     'microservices-vpc',
      maxAzs:      2,
      natGateways: 0,                       // saves ~$1/day
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // =========================================================================
    // 2. Security Groups
    //
    //   vpcLinkSg — attached to the API Gateway VPC Link ENIs
    //   albSg     — internal ALB; only accepts traffic from VPC Link
    //   ecsSg     — ECS tasks; accepts from ALB + inter-task Service Connect
    // =========================================================================
    const vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSg', {
      vpc,
      description:      'API Gateway VPC Link ENIs',
      allowAllOutbound: true,
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description:      'Internal ALB - accepts from VPC Link only',
      allowAllOutbound: true,
    });

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc,
      description:      'ECS Fargate tasks',
      allowAllOutbound: true,
    });

    albSg.addIngressRule(vpcLinkSg, ec2.Port.tcp(80),              'VPC Link to ALB');
    ecsSg.addIngressRule(albSg,     ec2.Port.tcpRange(8081, 8083), 'ALB to services');
    ecsSg.addIngressRule(ecsSg,     ec2.Port.allTcp(),             'Service Connect peer traffic');

    // =========================================================================
    // 3. ECR Repositories
    //
    //   imageScanOnPush: true — AWS runs a CVE scan server-side on every push
    //   as a second check after the Trivy scan in the CI/CD pipeline.
    //   Lifecycle rule: keep 10 most recent images.
    // =========================================================================
    const repoNames = ['product-service', 'inventory-service', 'order-service', 'postgres'] as const;
    const repos: Record<string, ecr.Repository> = {};

    for (const name of repoNames) {
      repos[name] = new ecr.Repository(this, `${name}Repo`, {
        repositoryName:   name,
        imageScanOnPush:  true,
        removalPolicy:    cdk.RemovalPolicy.DESTROY,
        autoDeleteImages: true,
        lifecycleRules:   [{ maxImageCount: 10, description: 'Keep last 10 images' }],
      });
    }

    // =========================================================================
    // 4. ECS Cluster + Service Connect namespace
    //
    //   Service Connect gives every container a short DNS name inside the
    //   "microservices" namespace — identical to Docker Compose service names:
    //     postgres:5432, product-service:8081, inventory-service:8082, …
    // =========================================================================
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName:       'microservices-cluster',
      containerInsights: true,
    });

    // Standalone namespace — DO NOT use cluster.addDefaultCloudMapNamespace().
    // That method creates a custom CloudFormation resource (PutClusterNamespace)
    // which is broken in CDK 2.114.1 and causes CREATE_FAILED.
    //
    // Instead: create the namespace standalone and reference it via
    // namespace.namespaceArn (a CloudFormation token) in serviceConnectConfiguration.
    // Using the ARN token — rather than the plain name string — causes CloudFormation
    // to generate an implicit DependsOn, so the namespace is fully created before
    // any ECS service tries to register with it.
    const namespace = new cloudmap.PrivateDnsNamespace(this, 'Namespace', {
      name: 'microservices',
      vpc,
      description: 'Service Connect namespace',
    });

    // =========================================================================
    // 5. Secrets Manager — PostgreSQL password
    //
    //   Auto-generated on first CDK deploy.  Both the postgres container and
    //   the Spring Boot services retrieve it at task startup — it is never
    //   stored in plaintext environment variables.
    // =========================================================================
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName:   'microservices/db-password',
      description:  'PostgreSQL master password for the microservices demo',
      generateSecretString: {
        excludePunctuation: true,
        includeSpace:       false,
        passwordLength:     20,
      },
    });

    // =========================================================================
    // 6. IAM Roles
    //
    //   executionRole — used by the ECS agent to pull ECR images, write
    //                   CloudWatch logs, and read Secrets Manager.
    //   taskRole      — assumed by the app process inside the container.
    //                   Extend when the app needs to call other AWS services.
    // =========================================================================
    const executionRole = new iam.Role(this, 'EcsExecutionRole', {
      roleName:        'microservices-ecs-execution-role',
      assumedBy:       new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    dbSecret.grantRead(executionRole);

    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName:  'microservices-ecs-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // =========================================================================
    // 7. CloudWatch Log Group — all containers stream here (1-week retention)
    // =========================================================================
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName:  '/ecs/microservices-demo',
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logDriver = (prefix: string) =>
      ecs.LogDrivers.awsLogs({ streamPrefix: prefix, logGroup });

    // =========================================================================
    // 8. Internal Application Load Balancer
    //
    //   "Internal" = no internet-facing DNS; reachable only via VPC Link.
    //   Path-based listener rules route each prefix to the right ECS service:
    //
    //     priority 10  /api/products*   → product-service   (8081)
    //     priority 20  /api/inventory*  → inventory-service (8082)
    //     priority 30  /api/orders*     → order-service     (8083)
    //     default      → 404 JSON
    // =========================================================================
    const alb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      vpc,
      loadBalancerName: 'microservices-internal-alb',
      internetFacing:   false,
      securityGroup:    albSg,
      vpcSubnets:       { subnetType: ec2.SubnetType.PUBLIC },
    });

    const albListener = alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: '{"error":"Route not found"}',
      }),
    });

    const makeTargetGroup = (id: string, port: number) =>
      new elbv2.ApplicationTargetGroup(this, id, {
        vpc,
        port,
        protocol:            elbv2.ApplicationProtocol.HTTP,
        targetType:          elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: {
          path:                    '/actuator/health',
          interval:                cdk.Duration.seconds(30),
          timeout:                 cdk.Duration.seconds(5),
          healthyThresholdCount:   2,
          unhealthyThresholdCount: 3,
        },
      });

    const productTg   = makeTargetGroup('ProductTg',   8081);
    const inventoryTg = makeTargetGroup('InventoryTg', 8082);
    const orderTg     = makeTargetGroup('OrderTg',     8083);

    albListener.addAction('ProductRule', {
      priority:   10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/products', '/api/products/*'])],
      action:     elbv2.ListenerAction.forward([productTg]),
    });
    albListener.addAction('InventoryRule', {
      priority:   20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/inventory', '/api/inventory/*'])],
      action:     elbv2.ListenerAction.forward([inventoryTg]),
    });
    albListener.addAction('OrderRule', {
      priority:   30,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/orders', '/api/orders/*'])],
      action:     elbv2.ListenerAction.forward([orderTg]),
    });

    // =========================================================================
    // 9. PostgreSQL ECS Service (ephemeral storage)
    //
    //   No EFS — data resets on every container restart, which is desirable
    //   for a demo: every session starts from a clean state and Flyway
    //   migrations run fresh on Spring Boot startup.
    //
    //   Service Connect registers "postgres:5432" so Spring Boot services use
    //   the same JDBC URL as Docker Compose: jdbc:postgresql://postgres:5432/<db>
    // =========================================================================
    const pgTaskDef = new ecs.FargateTaskDefinition(this, 'PostgresTask', {
      family:          'postgres',
      cpu:             512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
    });

    pgTaskDef.addContainer('postgres', {
      image:   ecs.ContainerImage.fromEcrRepository(repos['postgres'], imageTag),
      logging: logDriver('postgres'),
      environment: { POSTGRES_USER: 'postgres' },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret),
      },
      portMappings: [{
        name:          'postgres',
        containerPort: 5432,
        protocol:      ecs.Protocol.TCP,
      }],
      healthCheck: {
        command:     ['CMD-SHELL', 'pg_isready -U postgres'],
        interval:    cdk.Duration.seconds(10),
        timeout:     cdk.Duration.seconds(5),
        retries:     5,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    new ecs.FargateService(this, 'PostgresService', {
      cluster,
      serviceName:    'postgres',
      taskDefinition: pgTaskDef,
      desiredCount:   desiredCount > 0 ? 1 : 0,
      securityGroups: [ecsSg],
      vpcSubnets:     { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,                        // reaches ECR/CW without NAT
      serviceConnectConfiguration: {
        namespace: namespace.namespaceArn,
        services: [{
          portMappingName: 'postgres',
          discoveryName:   'postgres',
          dnsName:         'postgres',
          port:            5432,
        }],
      },
    });

    // =========================================================================
    // 10. Spring Boot Microservices
    // =========================================================================
    interface ServiceConfig {
      name:        string;
      port:        number;
      dbName:      string;
      targetGroup: elbv2.ApplicationTargetGroup;
      extraEnv?:   Record<string, string>;
    }

    const serviceConfigs: ServiceConfig[] = [
      {
        name:        'product-service',
        port:        8081,
        dbName:      'product_db',
        targetGroup: productTg,
      },
      {
        name:        'inventory-service',
        port:        8082,
        dbName:      'inventory_db',
        targetGroup: inventoryTg,
      },
      {
        name:        'order-service',
        port:        8083,
        dbName:      'order_db',
        targetGroup: orderTg,
        extraEnv: {
          // Service Connect DNS names match Docker Compose service names exactly
          SERVICES_PRODUCT_SERVICE_URL:   'http://product-service:8081',
          SERVICES_INVENTORY_SERVICE_URL: 'http://inventory-service:8082',
        },
      },
    ];

    for (const svc of serviceConfigs) {
      const taskDef = new ecs.FargateTaskDefinition(this, `${svc.name}Task`, {
        family:          svc.name,
        cpu:             512,
        memoryLimitMiB: 1024,
        executionRole,
        taskRole,
      });

      taskDef.addContainer(svc.name, {
        image:   ecs.ContainerImage.fromEcrRepository(repos[svc.name], imageTag),
        logging: logDriver(svc.name),
        environment: {
          SPRING_PROFILES_ACTIVE:     'docker',
          SPRING_DATASOURCE_URL:      `jdbc:postgresql://postgres:5432/${svc.dbName}`,
          SPRING_DATASOURCE_USERNAME: 'postgres',
          ...svc.extraEnv,
        },
        secrets: {
          SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret),
        },
        portMappings: [{
          name:          svc.name,
          containerPort: svc.port,
          protocol:      ecs.Protocol.TCP,
          appProtocol:   ecs.AppProtocol.http,
        }],
        healthCheck: {
          command:     ['CMD-SHELL', `curl -fsS http://localhost:${svc.port}/actuator/health || exit 1`],
          interval:    cdk.Duration.seconds(30),
          timeout:     cdk.Duration.seconds(5),
          retries:     3,
          startPeriod: cdk.Duration.seconds(90),
        },
      });

      const fargateService = new ecs.FargateService(this, `${svc.name}Service`, {
        cluster,
        serviceName:    svc.name,
        taskDefinition: taskDef,
        desiredCount,
        securityGroups: [ecsSg],
        vpcSubnets:     { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        serviceConnectConfiguration: {
          namespace: namespace.namespaceArn,
          services: [{
            portMappingName: svc.name,
            discoveryName:   svc.name,
            dnsName:         svc.name,
            port:            svc.port,
          }],
        },
      });

      fargateService.attachToApplicationTargetGroup(svc.targetGroup);
    }

    // =========================================================================
    // 11. AWS API Gateway HTTP API (public entry point)
    //
    //   Traffic path:
    //     Internet → API Gateway → VPC Link → Internal ALB → ECS tasks
    //
    //   The VPC Link bridges the public API Gateway to the internal ALB.
    //   The ALB listener rules then route by path prefix to the correct
    //   ECS service target group.
    // =========================================================================
    const vpcLink = new apigwv2.VpcLink(this, 'VpcLink', {
      vpc,
      vpcLinkName:    'microservices-vpc-link',
      subnets:        { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [vpcLinkSg],
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName:     'microservices-api',
      description: 'Public entry point for the microservices demo',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'apikey'],
        maxAge:       cdk.Duration.hours(1),
      },
    });

    const albIntegration = new integrations.HttpAlbIntegration(
      'AlbIntegration',
      albListener,
      { vpcLink, method: apigwv2.HttpMethod.ANY },
    );

    httpApi.addRoutes({
      path:        '/api/{proxy+}',
      methods:     [apigwv2.HttpMethod.ANY],
      integration: albIntegration,
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      exportName:  'ApiGatewayUrl',
      description: 'Public AWS API Gateway endpoint',
      value:       httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'EcrRegistry', {
      exportName: 'EcrRegistry',
      value:      `${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
    });
    new cdk.CfnOutput(this, 'ProductsEndpoint', {
      value: `${httpApi.apiEndpoint}/api/products`,
    });
    new cdk.CfnOutput(this, 'InventoryEndpoint', {
      value: `${httpApi.apiEndpoint}/api/inventory`,
    });
    new cdk.CfnOutput(this, 'OrdersEndpoint', {
      description: 'Requires header: apikey: lab-api-key-2026',
      value:       `${httpApi.apiEndpoint}/api/orders`,
    });
  }
}
