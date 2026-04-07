#!/usr/bin/env bash
# =============================================================================
# setup-aws-infra.sh
# One-time bootstrap script for the microservices demo.
#
# WHAT THIS SCRIPT DOES
# ─────────────────────
#   1. Creates a GitHub OIDC Identity Provider in IAM (if not already present).
#   2. Creates an IAM Role that GitHub Actions can assume via OIDC — no static
#      AWS access keys are required in GitHub.
#   3. Attaches an AdministratorAccess policy to the role so CDK can provision
#      all required resources.  Scope this down for production workloads.
#   4. Bootstraps CDK for the target account/region (creates the CDK toolkit
#      S3 bucket, ECR repo, IAM roles, etc.).
#   5. Runs an initial `cdk deploy` with desiredCount=0 so all infrastructure
#      (VPC, ECR repos, ECS cluster, internal ALB, API Gateway, Secrets Manager)
#      is created before the first CI/CD pipeline run.
#   6. Prints the secrets you need to add in GitHub.
#
# PREREQUISITES
# ─────────────
#   aws cli v2    (brew install awscli)
#   node + npm    (brew install node)
#   jq            (brew install jq)
#   AWS credentials with AdministratorAccess configured (aws configure)
#
# USAGE
# ─────
#   bash infra/setup-aws-infra.sh
#
# To tear down all resources afterwards:
#   cd infra/cdk && npx cdk destroy --force
# =============================================================================

set -euo pipefail

# =============================================================================
# ▼▼▼  CONFIGURE THESE VARIABLES BEFORE RUNNING  ▼▼▼
# =============================================================================

AWS_ACCOUNT_ID="775937640988"          # Your 12-digit AWS account ID
AWS_REGION="us-east-1"                 # AWS region to deploy into

GITHUB_ORG="ashishjuyal"           # GitHub organisation or username
GITHUB_REPO="kong-microservices-ref-app"  # Repository name (without the org prefix)
GITHUB_BRANCH="devsecops"              # Branch that is allowed to assume the role

# =============================================================================
# ▲▲▲  END OF CONFIGURATION  ▲▲▲
# =============================================================================

# ─── Colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="${SCRIPT_DIR}/cdk"

ROLE_NAME="github-actions-microservices-role"
OIDC_PROVIDER_URL="token.actions.githubusercontent.com"

# ─── Preflight checks ────────────────────────────────────────────────────────
header "Preflight"
command -v aws  >/dev/null 2>&1 || die "aws cli not found.  Install: brew install awscli"
command -v node >/dev/null 2>&1 || die "node not found.  Install: brew install node"
command -v npm  >/dev/null 2>&1 || die "npm not found.  Install: brew install node"
command -v jq   >/dev/null 2>&1 || die "jq not found.  Install: brew install jq"

CALLER=$(aws sts get-caller-identity --output json)
ACTUAL_ACCOUNT=$(echo "${CALLER}" | jq -r '.Account')

if [[ "${ACTUAL_ACCOUNT}" != "${AWS_ACCOUNT_ID}" ]]; then
  die "Configured AWS_ACCOUNT_ID (${AWS_ACCOUNT_ID}) does not match " \
      "current credentials (${ACTUAL_ACCOUNT}).  Update the variable at the top of the script."
fi

success "AWS account: ${AWS_ACCOUNT_ID}  region: ${AWS_REGION}"
info    "GitHub: ${GITHUB_ORG}/${GITHUB_REPO}  branch: ${GITHUB_BRANCH}"

# =============================================================================
# STEP 1 — GitHub OIDC Identity Provider
# =============================================================================
header "Step 1 — GitHub OIDC Identity Provider"

OIDC_PROVIDER_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_URL}"

if aws iam get-open-id-connect-provider \
     --open-id-connect-provider-arn "${OIDC_PROVIDER_ARN}" >/dev/null 2>&1; then
  info "OIDC provider already exists: ${OIDC_PROVIDER_ARN}"
else
  # GitHub's OIDC thumbprint (stable — used by all GitHub Actions customers)
  GITHUB_THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"

  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_PROVIDER_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "${GITHUB_THUMBPRINT}" >/dev/null

  success "Created OIDC provider: ${OIDC_PROVIDER_ARN}"
fi

# =============================================================================
# STEP 2 — IAM Role for GitHub Actions (OIDC trust)
# =============================================================================
header "Step 2 — IAM Role for GitHub Actions"

# Trust policy:  only the specific repo + branch may assume this role.
# The condition on "sub" prevents other repos or branches from using the role.
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${OIDC_PROVIDER_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER_URL}:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "${OIDC_PROVIDER_URL}:sub": "repo:${GITHUB_ORG}/${GITHUB_REPO}:*"
        }
      }
    }
  ]
}
EOF
)

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  info "IAM role already exists: ${ROLE_NAME}"
  # Update the trust policy in case the branch/repo changed
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "${TRUST_POLICY}" >/dev/null
  info "Trust policy updated."
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "Assumed by GitHub Actions via OIDC for ${GITHUB_ORG}/${GITHUB_REPO}" \
    >/dev/null
  success "Created IAM role: ${ROLE_NAME}"
fi

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"

# =============================================================================
# STEP 3 — Permissions Policy
# =============================================================================
header "Step 3 — Permissions Policy"

# AdministratorAccess is used here so CDK can create any resource.
# For production, replace with a least-privilege custom policy that covers
# only the services this CDK stack touches (EC2, ECS, ECR, ELB, APIGW,
# CloudFormation, IAM for CDK bootstrap roles, S3 for CDK assets, etc.).
POLICY_ARN="arn:aws:iam::aws:policy/AdministratorAccess"

ATTACHED=$(aws iam list-attached-role-policies \
  --role-name "${ROLE_NAME}" \
  --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'].PolicyArn" \
  --output text)

if [[ -n "${ATTACHED}" ]]; then
  info "Policy already attached: ${POLICY_ARN}"
else
  aws iam attach-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-arn "${POLICY_ARN}"
  success "Attached policy: ${POLICY_ARN}"
fi

warn "IMPORTANT: AdministratorAccess is used for convenience in this demo."
warn "Scope this down to least-privilege before any production use."

# =============================================================================
# STEP 4 — CDK Bootstrap
# =============================================================================
header "Step 4 — CDK Bootstrap"

info "Installing CDK dependencies in ${CDK_DIR}…"
(cd "${CDK_DIR}" && npm install --silent)
success "npm install complete"

info "Bootstrapping CDK for account ${AWS_ACCOUNT_ID} / region ${AWS_REGION}…"
info "(This creates the CDKToolkit stack — S3 bucket, ECR repo, IAM roles.)"
info "The GitHub Actions role is granted permission to use CDK assets."

(cd "${CDK_DIR}" && \
  AWS_DEFAULT_REGION="${AWS_REGION}" \
  npx cdk bootstrap \
    "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}" \
    --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess" \
    --trust "${ROLE_ARN}")

success "CDK bootstrap complete"

# =============================================================================
# STEP 5 — Initial CDK Deploy  (infrastructure only, no running tasks)
# =============================================================================
header "Step 5 — Initial CDK Deploy"

# If a previous attempt left the stack in ROLLBACK_COMPLETE or DELETE_FAILED,
# CDK cannot update it — it must be deleted first.
# ROLLBACK_COMPLETE: previous deploy failed and was rolled back (safe to delete).
# DELETE_FAILED:     a resource (e.g. VpcLink still PENDING) blocked deletion.
#                   We retry the delete, waiting for transient resources to settle.
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name MicroservicesStack \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [[ "${STACK_STATUS}" == "ROLLBACK_COMPLETE" ]]; then
  warn "Stack is in ROLLBACK_COMPLETE — deleting before redeploying..."
  aws cloudformation delete-stack --stack-name MicroservicesStack
  aws cloudformation wait stack-delete-complete --stack-name MicroservicesStack
  success "Deleted failed stack"
elif [[ "${STACK_STATUS}" == "DELETE_FAILED" ]]; then
  warn "Stack is in DELETE_FAILED — retrying delete (VpcLink may still be PENDING)..."
  # Wait 60s for the VpcLink to leave PENDING state, then retry
  sleep 60
  aws cloudformation delete-stack --stack-name MicroservicesStack
  aws cloudformation wait stack-delete-complete --stack-name MicroservicesStack
  success "Deleted failed stack"
fi

info "Deploying infrastructure with desiredCount=0..."
info "(ECR repos, VPC, ECS cluster, ALB, API Gateway, Secrets Manager)"
info "ECS tasks will not start until the CI/CD pipeline pushes real images."

CDK_OUTPUTS_FILE="${CDK_DIR}/cdk-outputs.json"

(cd "${CDK_DIR}" && \
  CDK_DEFAULT_ACCOUNT="${AWS_ACCOUNT_ID}" \
  CDK_DEFAULT_REGION="${AWS_REGION}" \
  npx cdk deploy MicroservicesStack \
    --require-approval never \
    --context imageTag=latest \
    --context desiredCount=0 \
    --outputs-file "${CDK_OUTPUTS_FILE}")

success "Infrastructure deployed"

# Parse outputs
API_URL=$(jq -r '.MicroservicesStack.ApiGatewayUrl // "pending"' "${CDK_OUTPUTS_FILE}")
ECR_REGISTRY=$(jq -r '.MicroservicesStack.EcrRegistry // "pending"' "${CDK_OUTPUTS_FILE}")

# =============================================================================
# DONE — Print GitHub Secrets
# =============================================================================
header "Setup Complete"

echo ""
echo -e "${BOLD}Add the following secrets to your GitHub repository:${NC}"
echo -e "  (Settings → Secrets and variables → Actions → New repository secret)"
echo ""
printf "  ${YELLOW}%-25s${NC}  %s\n" "Secret Name"           "Value"
printf "  ${YELLOW}%-25s${NC}  %s\n" "─────────────────────" "─────────────────────────────────────────────────────────"
printf "  %-25s  %s\n" "AWS_ROLE_ARN"           "${ROLE_ARN}"
printf "  %-25s  %s\n" "AWS_ACCOUNT_ID"          "${AWS_ACCOUNT_ID}"
echo ""
echo -e "  ${CYAN}Note:${NC} No static AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY needed."
echo -e "  ${CYAN}Note:${NC} GitHub Actions authenticates via OIDC (short-lived token)."
echo ""
echo -e "${BOLD}Infrastructure endpoints:${NC}"
printf "  %-25s  %s\n" "API Gateway URL"  "${API_URL}"
printf "  %-25s  %s\n" "ECR Registry"     "${ECR_REGISTRY}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Add the secrets above to GitHub (see output)"
echo "  2. Push to ${GITHUB_BRANCH} — the pipeline will build, scan, push and deploy"
echo "  3. On deploy, CDK runs with desiredCount=1 and starts all ECS tasks"
echo ""
echo -e "${BOLD}To tear everything down when finished:${NC}"
echo "  cd infra/cdk && npx cdk destroy --force"
echo ""
