Excellent 👍
Below are **two complete, ready-to-use Markdown documents** you can copy directly into your repo.

I’ve written them in a **trainer / architect-friendly style**, aligned exactly with **what you actually built** (Kind + Kong + Spring Boot + PostgreSQL + Istio + Prometheus/Grafana).

---

# 📄 1️⃣ `SETUP-GUIDE.md`

### *End-to-End Setup Guide: Kong + Kubernetes (Kind) + Istio Observability*

---

## 1. Purpose

This document provides a **step-by-step guide** to set up a complete microservices lab using:

* Spring Boot microservices
* PostgreSQL
* Kong API Gateway
* Kubernetes (Kind)
* Istio Service Mesh
* Prometheus & Grafana observability

The setup is intended for **learning, demos, and training**.

---

## 2. Prerequisites

### 2.1 Software

Install the following on your machine (Windows used in this lab):

* Docker Desktop (with Kubernetes disabled)
* Java 17+
* Maven 3.9+
* kubectl
* kind
* istioctl
* curl

Verify:

```bash
docker --version
kubectl version --client
kind version
istioctl version
java -version
```

---

## 3. Architecture Overview

```
Client / Integration Tests
        |
        v
Kong API Gateway (Docker)
        |
        v
NodePort (Host)
        |
        v
Kind Kubernetes Cluster (microservices-lab)
        |
        +-- product-service
        +-- inventory-service
        +-- order-service
        |
        +-- PostgreSQL
        |
        +-- Istio Sidecars (Envoy)
              |
              v
        Prometheus -> Grafana / Kiali
```

---

## 4. Create Kind Cluster

Create cluster with NodePort mappings:

```yaml
# kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30081
        hostPort: 30081
      - containerPort: 30082
        hostPort: 30082
      - containerPort: 30083
        hostPort: 30083
```

Create cluster:

```bash
kind create cluster --name microservices-lab --config kind-config.yaml
kubectl config use-context kind-microservices-lab
```

---

## 5. Build & Load Service Images

Build services:

Windows
```bash
docker build -t product-service:1.0 ./services/product-service
docker build -t inventory-service:1.0 ./services/inventory-service
docker build -t order-service:1.0 ./services/order-service
```

Macos
```bash
docker build -t product-service:1.0 ./services/product-service --platform linux/amd64
docker build -t inventory-service:1.0 ./services/inventory-service --platform linux/amd64
docker build -t order-service:1.0 ./services/order-service --platform linux/amd64
```

Load images into Kind:

```bash
kind load docker-image product-service:1.0 --name microservices-lab
kind load docker-image inventory-service:1.0 --name microservices-lab
kind load docker-image order-service:1.0 --name microservices-lab
```

---

## 6. Deploy PostgreSQL in Kubernetes

Deploy PostgreSQL with a ClusterIP service:

```bash
kubectl apply -f database.yaml
```

Create databases (one-time):

```bash
kubectl exec -it postgres-xxxxx -- psql -U postgres
```

```sql
CREATE DATABASE product_db;
CREATE DATABASE inventory_db;
CREATE DATABASE order_db;
```

---

## 7. Deploy Microservices

Apply Kubernetes manifests:

```bash
kubectl apply -f ./services/product-service/product-service.yaml
kubectl apply -f ./services/inventory-service/inventory-service.yaml
kubectl apply -f ./services/order-service/order-service.yaml
```

Verify:

```bash
kubectl get pods
kubectl get svc
```

Health checks:

```bash
curl http://localhost:30081/actuator/health
curl http://localhost:30082/actuator/health
curl http://localhost:30083/actuator/health
```

---

## 8. Run Kong API Gateway (Docker)

Start Kong using Docker Compose:

```bash
docker compose up -d kong konga
```

Kong ports:

* Proxy: `8000`
* Admin API: `8001`

Configure Kong services using upstreams like:

```
http://host.docker.internal:30081
```

⚠️ **Do not use `localhost` inside Kong**.

---

## 9. Integration Testing

Run E2E tests:

```bash
mvn verify -pl integration-tests \
  -Dgateway.url=http://127.0.0.1:8000
```

> ⚠️ Always use `127.0.0.1` (IPv4) instead of `localhost` on Windows.

---

## 10. Install Istio

Install istiocli

Windows
```bash
# look for appropriate version at https://github.com/istio/istio/releases/
```

Macos
```bash
brew install instiocli
```

Install Istio in the same cluster:

```bash
istioctl install --set profile=demo -y
```

Verify:

```bash
kubectl get pods -n istio-system
```

---

## 11. Enable Sidecar Injection

```bash
kubectl label namespace default istio-injection=enabled --overwrite
kubectl delete pod --all -n default
```

Verify pods:

```bash
kubectl get pods
```

Pods should show:

```
2/2 Running
```

---

## 12. Install Observability Stack

```bash
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.29/samples/addons/prometheus.yaml
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.29/samples/addons/grafana.yaml
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.29/samples/addons/kiali.yaml
```

---

## 13. Access Dashboards

```bash
istioctl dashboard kiali
istioctl dashboard grafana
istioctl dashboard prometheus
```

---

## 14. Generate Traffic

```bash
curl http://127.0.0.1:8000/api/products
mvn verify -pl integration-tests -Dgateway.url=http://127.0.0.1:8000
```

---

## 15. Outcome

You now have:

* Kubernetes-native microservices
* External API Gateway (Kong)
* Istio service mesh
* Full observability (metrics + topology)

---

# 📄 2️⃣ `TRAINING-CONTENT.md`

### *Understanding the Microservices, Kubernetes & Observability Stack*

---

## 1. Learning Objectives

By the end of this training, participants will understand:

* Microservices deployment on Kubernetes
* API Gateway vs Service Mesh
* Istio sidecar pattern
* Observability with Prometheus & Grafana
* Real-world networking pitfalls

---

## 2. Stack Components Explained

### 2.1 Spring Boot Microservices

* Product Service
* Inventory Service
* Order Service

Responsibilities:

* Independent deployment
* Database per service
* REST-based communication

---

### 2.2 PostgreSQL (Stateful Workload)

* Single PostgreSQL instance
* Multiple databases
* Demonstrates:

  * Stateful vs stateless workloads
  * Pod recreation implications
  * Importance of bootstrapping

---

### 2.3 Kong API Gateway

**Role: North–South traffic**

* Single entry point
* Routing
* API key authentication
* Rate limiting

Why Kong?

* Language agnostic
* Externalized security
* Works outside Kubernetes

---

### 2.4 Kubernetes (Kind)

Why Kind?

* Lightweight
* Local learning
* Real Kubernetes APIs

Key Kubernetes concepts demonstrated:

* Pods
* Services
* NodePort
* Readiness & liveness
* Labels & selectors

---

## 3. Docker Compose vs Kubernetes

| Aspect        | Docker Compose | Kubernetes  |
| ------------- | -------------- | ----------- |
| Networking    | Single bridge  | Multi-layer |
| Startup order | Controlled     | Declarative |
| Health checks | Optional       | Mandatory   |
| Failures      | Hidden         | Exposed     |

**Key takeaway:**

> Kubernetes exposes architectural weaknesses early.

---

## 4. Istio Service Mesh

### 4.1 What Istio Does

* Injects Envoy sidecars
* Intercepts service-to-service traffic
* Provides:

  * Metrics
  * Tracing
  * Security
  * Traffic control

No application code changes required.

---

### 4.2 Sidecar Pattern

```
Pod
 ├── Application Container
 └── istio-proxy (Envoy)
```

Envoy:

* Captures inbound & outbound traffic
* Emits telemetry automatically

---

## 5. Observability Stack

### 5.1 Prometheus

* Scrapes Envoy metrics
* Time-series storage
* Provides raw data

Example metric:

```promql
istio_requests_total
```

---

### 5.2 Grafana

* Visual dashboards
* Golden signals:

  * Latency
  * Traffic
  * Errors
  * Saturation

---

### 5.3 Kiali

* Service topology visualization
* Dependency graph
* Real-time traffic view

Best tool for:

* Explaining microservice interactions
* Demoing failures & retries

---

## 6. Common Real-World Pitfalls (Observed in Lab)

* `localhost` vs `127.0.0.1` on Windows
* Pod running but not **Ready**
* Missing databases after pod restart
* Service selectors not matching labels
* NodePort exposure in Kind

These are **real production issues**, not academic ones.

---

## 7. Key Takeaways

* Docker Compose simplifies; Kubernetes formalizes
* Observability is infrastructure-provided in service meshes
* Sidecars enable deep insights without code changes
* Hybrid setups expose networking realities
* Kubernetes enforces correctness early

---

## 8. Next Advanced Topics (Optional)

* mTLS between services
* Istio fault injection
* Circuit breaking & retries
* Replacing Kong with Istio Gateway
* Distributed tracing (Jaeger)

---

## 9. Summary

This lab demonstrates a **production-grade microservices architecture** using open-source tooling, exposing participants to **real-world engineering challenges** and modern observability practices.

---

If you want, next I can:

* Convert this into **slides**
* Add **diagrams (Mermaid / PNG)**
* Create a **trainer checklist**
* Add **hands-on exercises per section**

Just tell me 👍
