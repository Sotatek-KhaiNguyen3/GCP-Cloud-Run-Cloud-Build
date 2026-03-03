# gce-zero2prod · Lab: Cloud Build + Cloud Run + Secret Manager

> **Mục tiêu lab:** Triển khai cùng một app Node.js lên Cloud Run bằng Cloud Build làm CI/CD pipeline,
> và quản lý secrets qua Secret Manager — không cần tự quản lý VM hay runner.

---

## Mục lục

1. [Tổng quan lab](#1-tổng-quan-lab)
2. [Kiến trúc](#2-kiến-trúc)
3. [Luồng CI/CD chi tiết](#3-luồng-cicd-chi-tiết)
4. [Bước 1 — Bật APIs & chuẩn bị](#bước-1--bật-apis--chuẩn-bị)
5. [Bước 2 — Artifact Registry](#bước-2--artifact-registry)
6. [Bước 3 — Service Accounts & IAM](#bước-3--service-accounts--iam)
7. [Bước 4 — Secret Manager](#bước-4--secret-manager)
8. [Bước 5 — Viết `cloudbuild.yaml`](#bước-5--viết-cloudbuildyaml)
9. [Bước 6 — Kết nối GitHub & tạo Trigger](#bước-6--kết-nối-github--tạo-trigger)
10. [Bước 7 — Deploy lần đầu & verify](#bước-7--deploy-lần-đầu--verify)
11. [Demo: đổi version](#demo-đổi-version)
12. [So sánh với hướng GCE cũ](#so-sánh-với-hướng-gce-cũ)
13. [Cấu trúc project](#cấu-trúc-project)

---

## 1. Tổng quan lab

### App là gì?

Node.js Express server hiển thị dashboard thông tin deployment theo thời gian thực:

| Field | Ý nghĩa | Nguồn dữ liệu |
|---|---|---|
| App name | Tên ứng dụng | Biến môi trường `APP_NAME` |
| Version | Phiên bản release | `APP_VERSION` — inject lúc `docker build` từ `package.json` |
| Build Time | Thời điểm CI build | `BUILD_TIME` — inject lúc `docker build` |
| Hostname | Instance đang phục vụ request | `HOSTNAME` — Cloud Run tự set theo container ID |

Endpoints: `GET /` (dashboard UI) · `GET /health` (200 OK) · `GET /info` (JSON)

### Bản chất lab này dạy gì?

```
Lab cũ (GCE + self-hosted runner):   Developer lo VM + Runner + Nginx + SSL + Docker
Lab này (Cloud Build + Cloud Run):    GCP lo hết infra — developer chỉ lo code + cloudbuild.yaml
```

Ba dịch vụ GCP cốt lõi cần nắm:

| Dịch vụ | Vai trò | Tương đương trong hướng cũ |
|---|---|---|
| **Cloud Build** | Managed CI — chạy pipeline build/push/deploy | GitHub Actions self-hosted runner |
| **Cloud Run** | Serverless container runtime — auto-scale, HTTPS tự động | GCE VM + Docker + Nginx + Certbot |
| **Secret Manager** | Kho lưu trữ secrets có version, audit log, IAM | GitHub Secrets / file `.env` trên VM |

---

## 2. Kiến trúc

```
┌─────────────────────────────────────────────────────────────────────┐
│  Developer                                                          │
│  git push main                                                      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  GitHub webhook
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloud Build Trigger                                                │
│  (nhận webhook, khớp branch main → chạy cloudbuild.yaml)           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloud Build (GCP managed — không cần VM riêng)                    │
│                                                                     │
│  Step 1 [node:20-alpine]                                            │
│    └─ đọc package.json → lấy VERSION, BUILD_TIME                   │
│                                                                     │
│  Step 2 [docker]                                                    │
│    └─ docker build --build-arg APP_VERSION --build-arg BUILD_TIME   │
│                                                                     │
│  Step 3 [docker]                                                    │
│    └─ docker push → Artifact Registry                               │
│                                                                     │
│  Step 4 [gcloud]                                                    │
│    └─ gcloud run deploy (inject secrets từ Secret Manager)          │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ push image
              ┌─────────────┘
              ▼
┌─────────────────────────────┐        ┌─────────────────────────────┐
│  Artifact Registry          │        │  Secret Manager             │
│  (lưu Docker images)        │        │  APP_SECRET, DB_URL, ...    │
└─────────────────────────────┘        └─────────────┬───────────────┘
                                                     │ inject tại runtime
                                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloud Run  (asia-southeast1)                                       │
│                                                                     │
│  - Serverless: tự scale 0 → N instance theo traffic                │
│  - HTTPS tự động: *.run.app cert do Google quản lý                 │
│  - Env vars: APP_NAME, APP_VERSION, BUILD_TIME từ build             │
│  - Secrets:  APP_SECRET, DB_URL từ Secret Manager                  │
│                                                                     │
│  GET /          → Dashboard UI                                      │
│  GET /health    → 200 OK (Cloud Run health check)                   │
│  GET /info      → JSON metadata                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Luồng CI/CD chi tiết

```
git push main
  │
  ├─[1]─ GitHub gửi webhook → Cloud Build Trigger
  │
  ├─[2]─ Cloud Build clone repo về /workspace
  │
  ├─[3]─ Step "metadata" (node:20-alpine)
  │       VERSION  = $(node -p "require('./package.json').version")
  │       BUILD_TIME = $(date -u +"%Y-%m-%dT%H:%M:%SZ")
  │       → ghi vào /workspace/_version, /workspace/_build_time
  │         (các step sau đọc từ đây — /workspace là shared volume)
  │
  ├─[4]─ Step "build" (gcr.io/cloud-builders/docker)
  │       docker build
  │         --build-arg APP_VERSION=$VERSION
  │         --build-arg BUILD_TIME=$BUILD_TIME
  │         -t GAR_HOST/PROJECT/REPO/gce-zero2prod:$VERSION
  │         -t GAR_HOST/PROJECT/REPO/gce-zero2prod:latest
  │         .
  │
  ├─[5]─ Step "push" (gcr.io/cloud-builders/docker)
  │       docker push (versioned tag + latest)
  │       → image lưu trong Artifact Registry
  │
  ├─[6]─ Step "deploy" (gcr.io/cloud-builders/gcloud)
  │       gcloud run deploy gce-zero2prod
  │         --image=...gce-zero2prod:$VERSION
  │         --set-env-vars APP_NAME=...,APP_VERSION=$VERSION,BUILD_TIME=$BUILD_TIME
  │         --set-secrets APP_SECRET=APP_SECRET:latest   ← lấy từ Secret Manager
  │
  └─[7]─ Cloud Run rolling update (zero-downtime)
          URL: https://gce-zero2prod-xxxx-as.a.run.app
```

**Thời gian:** khoảng 2–4 phút từ push đến live (chủ yếu là bước docker build).

---

## Bước 1 — Bật APIs & chuẩn bị

```bash
# Xác nhận đang dùng đúng project
gcloud config set project YOUR_PROJECT_ID

# Bật các APIs cần thiết
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com
```

Gán biến shell để dùng xuyên suốt lab:

```bash
export PROJECT_ID=$(gcloud config get-value project)
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
export REGION=asia-southeast1
export REPO=gce-zero2prod        # tên Artifact Registry repo
export SERVICE=gce-zero2prod     # tên Cloud Run service
```

---

## Bước 2 — Artifact Registry

```bash
# Tạo repository lưu Docker images
gcloud artifacts repositories create $REPO \
  --repository-format=docker \
  --location=$REGION \
  --description="gce-zero2prod Docker images"
```

Kiểm tra:

```bash
gcloud artifacts repositories list --location=$REGION
```

Image path sẽ có dạng:
`asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/gce-zero2prod/gce-zero2prod:1.0.0`

---

## Bước 3 — Service Accounts & IAM

Lab này dùng **2 Service Account** với vai trò khác nhau:

```
Cloud Build SA      → chạy pipeline (build, push, deploy)
Cloud Run SA        → chạy app lúc runtime (đọc secrets)
```

### 3.1 Cloud Run Service Account

```bash
# Tạo SA cho Cloud Run runtime
gcloud iam service-accounts create cloudrun-zero2prod-sa \
  --display-name="Cloud Run gce-zero2prod SA"

# Gán quyền đọc Secret Manager
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:cloudrun-zero2prod-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3.2 Cloud Build Service Account

Cloud Build mặc định dùng SA: `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`

Gán thêm các quyền cần thiết:

```bash
CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

# Đẩy image lên Artifact Registry
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/artifactregistry.writer"

# Deploy lên Cloud Run
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/run.admin"

# Cho phép Cloud Build "đóng vai" Cloud Run SA khi deploy
gcloud iam service-accounts add-iam-policy-binding \
  cloudrun-zero2prod-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --member="serviceAccount:$CB_SA" \
  --role="roles/iam.serviceAccountUser"

# (Tùy chọn) Đọc Secret Manager trong bước build nếu cần
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/secretmanager.secretAccessor"
```

**Tại sao cần `iam.serviceAccountUser`?**
Khi Cloud Build chạy lệnh `gcloud run deploy --service-account=cloudrun-zero2prod-sa`,
GCP yêu cầu Cloud Build SA phải có quyền "act as" Cloud Run SA đó.
Không có quyền này → lỗi `Permission denied`.

---

## Bước 4 — Secret Manager

### Tư duy: secret nào cần lưu ở đây?

```
Không phải secret  →  lưu trong --set-env-vars khi deploy
  APP_NAME, APP_VERSION, BUILD_TIME, REGION, REPO_NAME...

Là secret         →  lưu trong Secret Manager
  DATABASE_URL, API_KEY, JWT_SECRET, STRIPE_KEY...
```

App demo này không có secret thật, nhưng lab tạo một secret mẫu để nắm cách vận hành:

### 4.1 Tạo secret

```bash
# Cách 1: Truyền giá trị trực tiếp
echo -n "super-secret-value-for-demo" | \
  gcloud secrets create APP_SECRET \
    --data-file=- \
    --replication-policy=automatic

# Cách 2: Từ file
gcloud secrets create DB_URL \
  --data-file=./db-url.txt \
  --replication-policy=automatic
```

### 4.2 Xem, update, version

```bash
# Xem danh sách secrets
gcloud secrets list

# Đọc giá trị (dùng khi debug — không nên làm thường xuyên)
gcloud secrets versions access latest --secret="APP_SECRET"

# Thêm version mới (rotate secret)
echo -n "new-secret-value" | gcloud secrets versions add APP_SECRET --data-file=-

# Xem lịch sử versions
gcloud secrets versions list APP_SECRET
```

### 4.3 Gán quyền đọc cho Cloud Run SA

```bash
# Quyền đọc SECRET cụ thể (chi tiết hơn, recommended)
gcloud secrets add-iam-policy-binding APP_SECRET \
  --member="serviceAccount:cloudrun-zero2prod-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Hoặc đã gán ở project level ở Bước 3.1 → secret này cũng được đọc tự động
```

> **Nguyên tắc least-privilege:** gán quyền per-secret thay vì project-level
> nếu app chỉ cần đọc một vài secret nhất định.

---

## Bước 5 — Viết `cloudbuild.yaml`

Tạo file `cloudbuild.yaml` ở **root** của repo (cùng cấp với `Dockerfile`):

```yaml
# cloudbuild.yaml
# CI/CD pipeline: Build → Push → Deploy to Cloud Run
# Trigger: git push main

steps:
  # ── Step 1: Đọc metadata từ package.json ─────────────────────────────────
  - name: 'node:20-alpine'
    id: 'metadata'
    entrypoint: sh
    args:
      - -c
      - |
        VERSION=$(node -p "require('./package.json').version")
        BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        echo "Version  : $VERSION"
        echo "BuildTime: $BUILD_TIME"
        echo "$VERSION"    > /workspace/_version
        echo "$BUILD_TIME" > /workspace/_build_time

  # ── Step 2: Build Docker image ────────────────────────────────────────────
  - name: 'gcr.io/cloud-builders/docker'
    id: 'build'
    entrypoint: sh
    args:
      - -c
      - |
        VERSION=$(cat /workspace/_version)
        BUILD_TIME=$(cat /workspace/_build_time)
        GAR_IMAGE="${_GAR_HOST}/$PROJECT_ID/${_REPO}/${_SERVICE}"
        docker build \
          --build-arg APP_VERSION="$VERSION" \
          --build-arg BUILD_TIME="$BUILD_TIME" \
          -t "$GAR_IMAGE:$VERSION" \
          -t "$GAR_IMAGE:latest" \
          .

  # ── Step 3: Push lên Artifact Registry ───────────────────────────────────
  - name: 'gcr.io/cloud-builders/docker'
    id: 'push'
    entrypoint: sh
    args:
      - -c
      - |
        VERSION=$(cat /workspace/_version)
        GAR_IMAGE="${_GAR_HOST}/$PROJECT_ID/${_REPO}/${_SERVICE}"
        docker push "$GAR_IMAGE:$VERSION"
        docker push "$GAR_IMAGE:latest"

  # ── Step 4: Deploy lên Cloud Run ─────────────────────────────────────────
  - name: 'gcr.io/cloud-builders/gcloud'
    id: 'deploy'
    entrypoint: sh
    args:
      - -c
      - |
        VERSION=$(cat /workspace/_version)
        BUILD_TIME=$(cat /workspace/_build_time)
        GAR_IMAGE="${_GAR_HOST}/$PROJECT_ID/${_REPO}/${_SERVICE}"

        gcloud run deploy ${_SERVICE} \
          --image="$GAR_IMAGE:$VERSION" \
          --region=${_REGION} \
          --platform=managed \
          --allow-unauthenticated \
          --service-account="cloudrun-zero2prod-sa@$PROJECT_ID.iam.gserviceaccount.com" \
          --set-env-vars="APP_NAME=${_SERVICE},APP_VERSION=$VERSION,BUILD_TIME=$BUILD_TIME" \
          --set-secrets="APP_SECRET=APP_SECRET:latest" \
          --min-instances=0 \
          --max-instances=3 \
          --memory=256Mi \
          --port=3000

        echo ""
        echo "  Deploy successful!"
        echo "  Version  : $VERSION"
        echo "  Build    : $BUILD_TIME"
        echo "  Image    : $GAR_IMAGE:$VERSION"

# ── Substitutions (giá trị mặc định, override khi cần) ───────────────────────
substitutions:
  _REGION: asia-southeast1
  _REPO: gce-zero2prod
  _SERVICE: gce-zero2prod
  _GAR_HOST: asia-southeast1-docker.pkg.dev

# ── Options ──────────────────────────────────────────────────────────────────
options:
  logging: CLOUD_LOGGING_ONLY   # log vào Cloud Logging, không tốn GCS bucket
```

### Giải thích các điểm quan trọng

**`/workspace` là shared volume:**
Mỗi step chạy trong container riêng biệt, nhưng thư mục `/workspace` được mount chung.
Đây là cách truyền giá trị giữa các steps (ghi file → step sau đọc file).

**`$PROJECT_ID` vs `${_VAR}`:**
- `$PROJECT_ID` — biến built-in của Cloud Build, tự động có giá trị
- `${_VAR}` — substitution tự định nghĩa trong `substitutions:` block

**`--set-secrets` vs `--set-env-vars`:**
```
--set-env-vars  →  plain text, hiện trong Cloud Run console, logs
--set-secrets   →  Cloud Run kéo từ Secret Manager lúc start container
                   App đọc như env var bình thường: process.env.APP_SECRET
                   Không lộ giá trị trong console hay logs
```

**`--allow-unauthenticated`:**
App demo public, không cần auth. App internal thì bỏ flag này.

---

## Bước 6 — Kết nối GitHub & tạo Trigger

### 6.1 Kết nối GitHub repo (lần đầu)

Vào **GCP Console → Cloud Build → Repositories → Connect Repository**:
1. Chọn source: **GitHub**
2. Authenticate → chọn repo `gce-zero2prod`
3. Xác nhận kết nối

Hoặc dùng CLI (cần cài `gcloud beta`):

```bash
gcloud builds connections create github my-github-connection \
  --region=$REGION
```

### 6.2 Tạo Build Trigger

```bash
gcloud builds triggers create github \
  --name="deploy-on-push-main" \
  --region=$REGION \
  --repo-name="gce-zero2prod" \
  --repo-owner="YOUR_GITHUB_USERNAME" \
  --branch-pattern="^main$" \
  --build-config="cloudbuild.yaml" \
  --description="Deploy to Cloud Run on push to main"
```

Hoặc qua Console: **Cloud Build → Triggers → Create Trigger**:

| Trường | Giá trị |
|---|---|
| Name | `deploy-on-push-main` |
| Event | Push to a branch |
| Branch | `^main$` |
| Configuration | Cloud Build configuration file |
| File location | `cloudbuild.yaml` |

### 6.3 Kiểm tra trigger

```bash
gcloud builds triggers list --region=$REGION
```

---

## Bước 7 — Deploy lần đầu & verify

### 7.1 Trigger thủ công lần đầu

```bash
# Chạy pipeline ngay mà không cần push code
gcloud builds triggers run deploy-on-push-main \
  --region=$REGION \
  --branch=main
```

### 7.2 Xem log build realtime

```bash
# Lấy build ID mới nhất
BUILD_ID=$(gcloud builds list --region=$REGION --limit=1 --format="value(id)")

# Stream log
gcloud builds log $BUILD_ID --region=$REGION --stream
```

Hoặc vào Console: **Cloud Build → History** → click vào build đang chạy.

### 7.3 Lấy URL Cloud Run

```bash
gcloud run services describe $SERVICE \
  --region=$REGION \
  --format="value(status.url)"
```

Output dạng: `https://gce-zero2prod-xxxxxxxxxxxx-as.a.run.app`

### 7.4 Verify

```bash
SERVICE_URL=$(gcloud run services describe $SERVICE \
  --region=$REGION \
  --format="value(status.url)")

# Health check
curl $SERVICE_URL/health
# → OK

# App info
curl $SERVICE_URL/info
# → {"app":"gce-zero2prod","version":"1.0.0","buildTime":"...","hostname":"..."}

# Mở dashboard trong browser
echo $SERVICE_URL
```

### 7.5 Verify secret được inject

```bash
# Secret sẽ không hiện trong /info vì app chưa đọc APP_SECRET
# Nhưng có thể kiểm tra Cloud Run đã nhận secret chưa:
gcloud run services describe $SERVICE \
  --region=$REGION \
  --format="yaml" | grep -A5 "secretKeyRef"
```

---

## Demo: đổi version

Đây là workflow bình thường sau khi setup xong:

```bash
# 1. Sửa version trong package.json
#    "version": "2.0.0"

# 2. Commit & push
git add package.json
git commit -m "bump version to 2.0.0"
git push

# 3. Cloud Build tự động trigger
#    Xem tiến trình: Console → Cloud Build → History

# 4. Sau ~2-3 phút, refresh browser → thấy Version: 2.0.0
```

**Điều gì xảy ra bên trong:**

```
package.json version: 2.0.0
  │
  ├─ Step 1 đọc → VERSION=2.0.0
  ├─ Step 2 build image:latest với --build-arg APP_VERSION=2.0.0
  ├─ Step 3 push image tag :2.0.0 và :latest
  └─ Step 4 deploy Cloud Run với image:2.0.0
             Cloud Run rolling update → zero downtime
             Dashboard hiển thị: Version 2.0.0, BuildTime = thời điểm build
```

---

## So sánh với hướng GCE cũ

| Tiêu chí | GCE + Self-hosted Runner | Cloud Build + Cloud Run |
|---|---|---|
| **File CI config** | `.github/workflows/deploy.yml` | `cloudbuild.yaml` |
| **CI runner** | Tự quản lý (GCE VM) | GCP managed |
| **Runtime** | GCE VM + Docker + Nginx | Cloud Run (serverless) |
| **HTTPS/SSL** | Nginx + Certbot (tự setup) | Tự động (`*.run.app`) |
| **Scale** | Thủ công (clone VM) | Tự động (0 → N instances) |
| **Secrets** | GitHub Secrets + file trên VM | Secret Manager |
| **Xác thực GCP** | SA gắn vào VM (ADC) | SA gắn vào Cloud Build / Cloud Run |
| **Chi phí infra** | VM chạy 24/7 (dù không có traffic) | Pay-per-request (scale to 0) |
| **Độ phức tạp setup** | Cao (cài runner, Nginx, SSL...) | Thấp (chỉ cần cloudbuild.yaml) |
| **Kiểm soát OS** | Toàn quyền | Không (GCP quản lý) |

**Khi nào dùng GCE hướng cũ:**
- App cần long-running process (WebSocket, cron job phức tạp...)
- Cần kiểm soát OS, custom kernel module
- Cần persistent disk mount

**Khi nào dùng Cloud Build + Cloud Run (lab này):**
- HTTP/HTTPS request-response app
- Muốn zero-ops infra — không muốn quản lý VM
- Cần auto-scale nhanh theo traffic

---

## Cấu trúc project

```
gce-zero2prod/
├── app.js                     ← Express server + dashboard UI
├── package.json               ← version field → inject vào image
├── Dockerfile                 ← ARG APP_VERSION, ARG BUILD_TIME
├── cloudbuild.yaml            ← CI/CD pipeline (Cloud Build) ← THÊM MỚI
├── .env.example               ← template biến môi trường
├── .gitignore
├── README.md
└── .github/
    └── workflows/
        └── deploy.yml         ← pipeline cũ (GCE) — giữ lại để so sánh
```

> `cloudbuild.yaml` và `.github/workflows/deploy.yml` không conflict với nhau.
> Chỉ cần tắt trigger GitHub Actions (disable workflow) để tránh chạy song song.
