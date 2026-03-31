# (Optional) Enabling Prometheus at application level

Add the management endpoint in `application.yml` and enable prometheus metrics
```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    prometheus:
      enabled: true
  metrics:
    export:
      prometheus:
        enabled: true
```

Add the dependency in `pom.xml`

```xml
<!-- this one is already there -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>

<!-- this one is required -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

Enable annotations in k8s manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: product-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: product-service
  template:
    metadata:
      labels:
        app: product-service
    annotations:                            # <-- HERE (pod level, not deployment level)
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/actuator/prometheus"        
    spec:
      containers:
        - name: product-service
          image: product-service:1.0
          imagePullPolicy: Never
          ports:
            - containerPort: 8081
          env:
            - name: SPRING_DATASOURCE_URL
              value: jdbc:postgresql://postgres:5432/product_db
            - name: SPRING_DATASOURCE_USERNAME
              value: postgres
            - name: SPRING_DATASOURCE_PASSWORD
              value: postgres
---
apiVersion: v1
kind: Service
metadata:
  name: product-service
spec:
  type: NodePort
  selector:
    app: product-service
  ports:
    - port: 8081
      targetPort: 8081
      nodePort: 30081
```

Build the application and test the endpoint with curl

```bash
curl http://localhost:8081/actuator/prometheus
```