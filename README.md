# Deployment Thinking — cloudrun_cloudbuild

> Tài liệu này mô tả tư duy kiến trúc và thứ tự triển khai cho lab:
> **Node.js DevOps Dashboard + Deployment History trên Cloud Run + Cloud Build + Cloud SQL + Secret Manager**

---

## 1. Tổng quan kiến trúc

```
Developer
    │  git push main
    ▼
GitHub Repository
    │  webhook trigger
    ▼
Cloud Build (managed CI/CD — không cần VM, không cần runner)
    ├─ Step 1: docker build --build-arg VERSION --build-arg BUILD_TIME
    ├─ Step 2: docker push → Artifact Registry
    ├─ Step 3: gcloud run deploy → Cloud Run
    └─ Step 4: ghi deployment record → Cloud SQL (via Cloud SQL Auth Proxy)
                        │
                        │ secrets tại runtime
                        ▼
                  Secret Manager
                  └─ DB_PASSWORD

Cloud Run (serverless container)
    ├─ Node.js app — port 3000
    ├─ Kết nối Cloud SQL qua built-in Cloud SQL Auth Proxy
    ├─ HTTPS tự động — không cần Nginx, không cần Certbot
    └─ Scale to zero khi không có traffic

Cloud SQL (PostgreSQL 15)
    └─ Table: deployments
       (id, version, build_time, commit_sha, deployed_at, status)

Cloud DNS
    └─ custom domain → Cloud Run URL
```

---

## 2. Lý do chọn từng service

| Service | Thay thế cái gì | Lý do |
|---------|-----------------|-------|
| **Cloud Build** | GitHub Actions + self-hosted runner trên GCE | Managed hoàn toàn, không cần VM, trigger trực tiếp từ GitHub |
| **Cloud Run** | GCE VM + docker run | Serverless, auto scale, HTTPS tự động, không quản lý OS |
| **Cloud SQL** | PostgreSQL trong docker-compose | Managed DB, backup tự động, kết nối Cloud Run qua proxy built-in |
| **Secret Manager** | .env file / env var hardcode | Secrets không nằm trong code, rotate được, audit log |
| **Artifact Registry** | Docker Hub | Nằm trong GCP, auth bằng Service Account, private |

---

## 3. Flow triển khai (theo team flow)

### Bước 1 — Chuẩn bị GCP _(= "Install dependencies")_

```
Enable APIs:
  - cloudbuild.googleapis.com
  - run.googleapis.com
  - sqladmin.googleapis.com
  - secretmanager.googleapis.com
  - artifactregistry.googleapis.com

Tạo Artifact Registry repository:
  - Format: Docker
  - Location: asia-southeast1
  - Name: cloudrun-zero2prod

Tạo Service Accounts:
  ┌─ SA cho Cloud Run (runtime)
  │   Email: cloudrun-sa@PROJECT.iam.gserviceaccount.com
  │   Roles:
  │     - roles/cloudsql.client        ← kết nối Cloud SQL
  │     - roles/secretmanager.secretAccessor ← đọc secrets
  │
  └─ SA cho Cloud Build (CI/CD)
      Email: cloudbuild-sa@PROJECT.iam.gserviceaccount.com (hoặc dùng default)
      Roles:
        - roles/run.admin              ← deploy Cloud Run
        - roles/iam.serviceAccountUser ← act as Cloud Run SA
        - roles/artifactregistry.writer ← push image
        - roles/cloudsql.client        ← ghi deployment history
        - roles/secretmanager.secretAccessor ← đọc DB password khi ghi history
```

### Bước 2 — Tạo Cloud SQL + Secret Manager _(= "Setup DB tier")_

```
Cloud SQL:
  - Engine: PostgreSQL 15
  - Instance: cloudrun-zero2prod-db
  - Region: asia-southeast1
  - Tier: db-f1-micro (lab)
  - Database: zero2prod
  - User: app_user / password: <random>

Tạo bảng deployments (chạy init.sql):
  CREATE TABLE deployments (
    id          SERIAL PRIMARY KEY,
    version     VARCHAR(50)  NOT NULL,
    build_time  TIMESTAMPTZ  NOT NULL,
    commit_sha  VARCHAR(10)  NOT NULL,
    deployed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status      VARCHAR(20)  NOT NULL DEFAULT 'success'
  );

Secret Manager:
  - Secret name: DB_PASSWORD
  - Value: <password của app_user>
  - Secret name: DB_CONNECTION_STRING  (optional, hoặc build từ env vars)
```

### Bước 3 — Build image + Deploy Cloud Run lần đầu (thủ công) _(= "Build/run app")_

```
# Build & push image thủ công để verify trước khi làm CI/CD
docker build -t asia-southeast1-docker.pkg.dev/PROJECT/cloudrun-zero2prod/app:1.0.0 .
docker push asia-southeast1-docker.pkg.dev/PROJECT/cloudrun-zero2prod/app:1.0.0

# Deploy Cloud Run lần đầu
gcloud run deploy cloudrun-zero2prod \
  --image asia-southeast1-docker.pkg.dev/PROJECT/cloudrun-zero2prod/app:1.0.0 \
  --region asia-southeast1 \
  --platform managed \
  --allow-unauthenticated \
  --service-account cloudrun-sa@PROJECT.iam.gserviceaccount.com \
  --add-cloudsql-instances PROJECT:asia-southeast1:cloudrun-zero2prod-db \
  --set-env-vars INSTANCE_CONNECTION_NAME=PROJECT:asia-southeast1:cloudrun-zero2prod-db \
  --set-env-vars DB_NAME=zero2prod \
  --set-env-vars DB_USER=app_user \
  --set-secrets DB_PASSWORD=DB_PASSWORD:latest \
  --port 3000

# Verify
curl https://<cloud-run-url>/health  → 200 OK
curl https://<cloud-run-url>/info    → JSON
curl https://<cloud-run-url>/        → Dashboard
```

### Bước 4 — Domain + SSL _(= "Config reverse proxy + trỏ domain + SSL")_

```
# Cloud Run tự cấp HTTPS — không cần Nginx, không cần Certbot

# Map custom domain (nếu cần)
gcloud run domain-mappings create \
  --service cloudrun-zero2prod \
  --domain app.example.com \
  --region asia-southeast1

# Cloud DNS: tạo CNAME record
app.example.com → ghs.googlehosted.com

# SSL: Cloud Run tự cấp cert Let's Encrypt → không cần làm gì thêm
```

### Bước 5 — Cloud Build CI/CD _(= "Làm CI/CD")_

```
1. Viết cloudbuild.yaml (xem Section 5)
2. Connect GitHub repo vào Cloud Build:
   GCP Console → Cloud Build → Triggers → Connect Repository → GitHub App
3. Tạo trigger:
   - Event: Push to branch (main)
   - Config: cloudbuild.yaml
4. Test: push code → xem Cloud Build chạy
```

---

## 4. Cloud Run — cơ chế kết nối Cloud SQL

Cloud Run có built-in Cloud SQL Auth Proxy. Không cần cài proxy thủ công.

```
Cách kết nối trong Node.js (pg library):

Khi chạy trên Cloud Run:
  host = /cloudsql/PROJECT:REGION:INSTANCE  ← Unix socket

Khi chạy local:
  host = 127.0.0.1 (qua cloud-sql-proxy local)

Env vars Cloud Run cần:
  INSTANCE_CONNECTION_NAME = PROJECT:asia-southeast1:cloudrun-zero2prod-db
  DB_NAME = zero2prod
  DB_USER = app_user
  DB_PASSWORD = <từ Secret Manager>
  DB_SOCKET_PATH = /cloudsql (mặc định)
```

---

## 5. cloudbuild.yaml — logic từng step

```yaml
steps:
  # Step 1: Build image
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'build',
      '--build-arg', 'APP_VERSION=$TAG_NAME',        # hoặc từ package.json
      '--build-arg', 'BUILD_TIME=$BUILD_TIMESTAMP',
      '-t', 'REGION-docker.pkg.dev/PROJECT/REPO/app:$SHORT_SHA',
      '-t', 'REGION-docker.pkg.dev/PROJECT/REPO/app:latest',
      '.'
    ]

  # Step 2: Push image
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', '--all-tags', 'REGION-docker.pkg.dev/PROJECT/REPO/app']

  # Step 3: Deploy Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args: [
      'run', 'deploy', 'cloudrun-zero2prod',
      '--image', 'REGION-docker.pkg.dev/PROJECT/REPO/app:$SHORT_SHA',
      '--region', 'asia-southeast1',
      '--platform', 'managed'
    ]

  # Step 4: Ghi deployment history → Cloud SQL
  # Chạy script Node.js nhỏ kết nối Cloud SQL Proxy và INSERT record
  - name: 'node:20-alpine'
    entrypoint: 'node'
    args: ['scripts/record-deploy.js']
    env:
      - 'VERSION=$TAG_NAME'
      - 'COMMIT_SHA=$SHORT_SHA'
      - 'BUILD_TIME=$BUILD_TIMESTAMP'
    secretEnv: ['DB_PASSWORD']

# Cloud Build lấy secret từ Secret Manager
availableSecrets:
  secretManager:
    - versionName: projects/$PROJECT_ID/secrets/DB_PASSWORD/versions/latest
      env: 'DB_PASSWORD'
```

**Tại sao Step 4 dùng riêng một script thay vì psql?**
- Node.js (pg) + Cloud SQL Proxy built-in trong Cloud Build dễ config hơn psql
- Cùng ngôn ngữ với app, dễ maintain

---

## 6. Secret Manager — cách app đọc secrets

```
Có 2 cách Cloud Run đọc Secret Manager:

Cách 1 — Mount as env var (đơn giản, dùng cho lab này):
  --set-secrets DB_PASSWORD=DB_PASSWORD:latest
  → App đọc: process.env.DB_PASSWORD

Cách 2 — Mount as file:
  --set-secrets /secrets/db=DB_PASSWORD:latest
  → App đọc file tại runtime

Cách 3 — SDK call tại runtime:
  const {SecretManagerServiceClient} = require('@google-cloud/secret-manager')
  → Gọi API mỗi lần cần (dùng khi secret cần rotate không restart service)

→ Chọn Cách 1 cho lab này: đơn giản nhất
```

---

## 7. App — Deployment History

```
Endpoint mới: GET /history
  → Query Cloud SQL: SELECT * FROM deployments ORDER BY deployed_at DESC LIMIT 10
  → Hiển thị trong dashboard

Endpoint hiện có:
  GET /         → HTML Dashboard (thêm bảng deployment history)
  GET /health   → 200 OK
  GET /info     → JSON metadata

Schema bảng deployments:
  id          SERIAL PRIMARY KEY
  version     VARCHAR(50)   -- "2.0.0"
  build_time  TIMESTAMPTZ   -- lúc docker build
  commit_sha  VARCHAR(10)   -- "abc1234"
  deployed_at TIMESTAMPTZ   -- DEFAULT NOW()
  status      VARCHAR(20)   -- "success"
```

---

## 8. Cấu trúc file project

```
cloudrun_cloudbuild/
├── app.js                  ← Express server + dashboard + /history endpoint
├── package.json            ← thêm dep: pg
├── Dockerfile              ← giữ nguyên cấu trúc cũ
├── cloudbuild.yaml         ← CI/CD pipeline (thay .github/workflows/)
├── .env.example            ← template cho local dev
├── .gitignore
├── sql/
│   └── init.sql            ← CREATE TABLE deployments
└── scripts/
    └── record-deploy.js    ← script ghi history, chạy trong Cloud Build step 4
```

---

## 9. So sánh với lab GCE trước

| | GCE + GitHub Actions | Cloud Run + Cloud Build |
|--|--|--|
| Hosting | GCE VM (luôn chạy) | Cloud Run (scale to zero) |
| CI/CD runner | Self-hosted trên GCE | Cloud Build (managed) |
| Reverse proxy | Nginx trên VM | Không cần |
| SSL | Certbot thủ công | Cloud Run tự động |
| DB | Không có | Cloud SQL |
| Secrets | Env var trong docker run | Secret Manager |
| Domain | Cloud DNS → GCE IP | Cloud DNS → Cloud Run URL |
| Chi phí | VM chạy 24/7 | Pay per request + Cloud SQL |

---

## 10. IAM Summary — ai cần quyền gì

```
Cloud Build Service Account:
  roles/run.admin                    ← deploy Cloud Run
  roles/iam.serviceAccountUser       ← act as Cloud Run SA khi deploy
  roles/artifactregistry.writer      ← push Docker image
  roles/cloudsql.client              ← kết nối Cloud SQL (ghi history)
  roles/secretmanager.secretAccessor ← đọc DB_PASSWORD

Cloud Run Service Account:
  roles/cloudsql.client              ← kết nối Cloud SQL (đọc history)
  roles/secretmanager.secretAccessor ← đọc DB_PASSWORD lúc runtime
```

---

## 11. Checklist triển khai

- [ ] Enable 5 GCP APIs
- [ ] Tạo Artifact Registry repository
- [ ] Tạo 2 Service Accounts + gán roles
- [ ] Tạo Cloud SQL instance + database + chạy init.sql
- [ ] Tạo Secret Manager secret (DB_PASSWORD)
- [ ] Build + push image thủ công (verify Dockerfile)
- [ ] Deploy Cloud Run lần đầu (verify app + DB connection)
- [ ] Test /health, /info, /history
- [ ] Domain mapping + DNS (nếu cần custom domain)
- [ ] Viết cloudbuild.yaml
- [ ] Viết scripts/record-deploy.js
- [ ] Connect GitHub → Cloud Build trigger
- [ ] Push code → verify pipeline chạy end-to-end
- [ ] Verify deployment record xuất hiện trong /history
