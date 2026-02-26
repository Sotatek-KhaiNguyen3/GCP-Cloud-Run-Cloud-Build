# gce-zero2prod · DevOps Version Dashboard

> CI/CD demo app — mỗi lần push code là thấy version mới trên web ngay.

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Kiến trúc](#2-kiến-trúc)
3. [Chạy local](#3-chạy-local)
4. [Chuẩn bị GCP](#4-chuẩn-bị-gcp)
5. [Tạo GCE VM](#5-tạo-gce-vm)
6. [Setup VM lần đầu](#6-setup-vm-lần-đầu)
7. [Cấu hình GitHub](#7-cấu-hình-github)
8. [Cấu hình DNS](#8-cấu-hình-dns)
9. [Luồng CI/CD](#9-luồng-cicd)
10. [Demo: đổi version](#10-demo-đổi-version)
11. [API Reference](#11-api-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Tổng quan

Web app đơn giản hiển thị thông tin deployment theo thời gian thực:

| Field      | Giá trị ví dụ          | Ý nghĩa                          |
|------------|------------------------|----------------------------------|
| App name   | `gce-zero2prod`        | Tên ứng dụng                     |
| Version    | `1.2.0`                | Từ `package.json`                |
| Build time | `2026-02-26T08:00:00Z` | Inject lúc `docker build`        |
| Hostname   | `gce-instance-1`       | Tên VM — đổi khi scale           |

**Stack:** Node.js · Docker · Artifact Registry · GitHub Actions · Nginx · Certbot · Cloud DNS

---

## 2. Kiến trúc

```
┌──────────────────────────────────────────────────────────────┐
│  Developer                                                   │
│  git push main                                               │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  GitHub Actions                                              │
│  (job chạy trên self-hosted runner — chính là GCE VM)       │
│                                                              │
│  1. docker build --build-arg VERSION --build-arg BUILD_TIME  │
│  2. docker push → Artifact Registry                          │
│  3. docker stop/run (deploy tại chỗ)                         │
│  4. curl /health → verify                                    │
└─────────────────────┬────────────────────────────────────────┘
                      │ chạy trực tiếp trên
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  GCE VM (e2-micro hoặc lớn hơn)                             │
│                                                              │
│  ┌─────────────────────────────────────────┐                │
│  │  Nginx :443  ──proxy──►  Node.js :3000  │                │
│  │  Nginx :80   ──301──►   :443            │                │
│  └─────────────────────────────────────────┘                │
│                                                              │
│  SSL cert: Let's Encrypt (Certbot)                          │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  Cloud DNS                                                   │
│  app.example.com  A  →  <GCE External IP>                   │
└──────────────────────────────────────────────────────────────┘
```

**Tại sao không cần GCP secret trong GitHub?**
Runner chạy ngay trên GCE VM, dùng Service Account của VM để xác thực Artifact Registry. Không cần lưu key nào trong GitHub Secrets.

---

## 3. Chạy local

### Yêu cầu
- Node.js ≥ 18

```bash
# Clone repo
git clone https://github.com/YOUR_USERNAME/gce-zero2prod.git
cd gce-zero2prod

# Cài dependencies
npm install

# Chạy
npm start
# hoặc watch mode (Node 18+)
npm run dev
```

Mở browser: [http://localhost:3000](http://localhost:3000)

### Test API

```bash
curl localhost:3000/health
# → OK

curl localhost:3000/info
# → {"app":"gce-zero2prod","version":"1.0.0","buildTime":"...","hostname":"..."}
```

### Override biến môi trường

```bash
APP_VERSION=2.0.0 BUILD_TIME=2026-02-26T00:00:00Z node app.js
```

---

## 4. Chuẩn bị GCP

### 4.1 Bật APIs

```bash
gcloud services enable \
  compute.googleapis.com \
  artifactregistry.googleapis.com \
  dns.googleapis.com
```

### 4.2 Tạo Artifact Registry repository

```bash
gcloud artifacts repositories create gce-zero2prod \
  --repository-format=docker \
  --location=asia-southeast1 \
  --description="gce-zero2prod images"
```

### 4.3 Tạo Service Account cho GCE VM

```bash
# Tạo SA
gcloud iam service-accounts create gce-zero2prod-sa \
  --display-name="GCE zero2prod SA"

# Gán quyền Artifact Registry Writer
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gce-zero2prod-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

---

## 5. Tạo GCE VM

```bash
gcloud compute instances create gce-zero2prod \
  --machine-type=e2-micro \
  --zone=asia-southeast1-b \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --service-account=gce-zero2prod-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --tags=http-server,https-server \
  --boot-disk-size=20GB
```

### Mở firewall

```bash
# Nếu chưa có rules
gcloud compute firewall-rules create allow-http \
  --allow=tcp:80 --target-tags=http-server

gcloud compute firewall-rules create allow-https \
  --allow=tcp:443 --target-tags=https-server
```

### Lấy External IP

```bash
gcloud compute instances describe gce-zero2prod \
  --zone=asia-southeast1-b \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)"
```

> **Khuyến nghị:** Đặt Static IP để DNS không bị thay đổi:
> ```bash
> gcloud compute addresses create gce-zero2prod-ip --region=asia-southeast1
> ```

---

## 6. Setup VM lần đầu

SSH vào VM:

```bash
gcloud compute ssh gce-zero2prod --zone=asia-southeast1-b
```

Clone repo và chạy setup script:

```bash
git clone https://github.com/YOUR_USERNAME/gce-zero2prod.git
cd gce-zero2prod
chmod +x scripts/setup-gce.sh
./scripts/setup-gce.sh
```

Script sẽ hỏi:

| Prompt | Ví dụ |
|--------|-------|
| Domain name | `app.example.com` |
| GCP Project ID | `my-project-123` |
| Artifact Registry region | `asia-southeast1` |
| GitHub repo | `yourname/gce-zero2prod` |
| GitHub runner token | *(lấy ở bước 7.2)* |

Script tự động cài đặt:
- Docker
- Nginx + Certbot + SSL certificate
- GitHub Actions self-hosted runner (chạy như systemd service)
- Cấu hình `gcloud` Docker auth cho Artifact Registry

### Sau khi script xong

```bash
# Log out rồi log in lại để docker group có hiệu lực
exit
gcloud compute ssh gce-zero2prod --zone=asia-southeast1-b

# Kiểm tra runner
sudo /home/$USER/actions-runner/svc.sh status

# Kiểm tra Nginx
sudo nginx -t
sudo systemctl status nginx
```

---

## 7. Cấu hình GitHub

### 7.1 Repository Variables

Vào **Settings → Secrets and variables → Actions → Variables → New repository variable**:

| Variable | Giá trị |
|----------|---------|
| `GCP_PROJECT_ID` | `my-project-123` |
| `GAR_LOCATION` | `asia-southeast1` |
| `GAR_REPOSITORY` | `gce-zero2prod` |

> Variables (không phải Secrets) vì các giá trị này không nhạy cảm.

### 7.2 Lấy Runner Registration Token

**Settings → Actions → Runners → New self-hosted runner**

Chọn **Linux** → copy token từ dòng `--token XXXXX`

Dùng token này khi chạy `setup-gce.sh`.

### 7.3 Verify runner online

**Settings → Actions → Runners** — runner phải có trạng thái **Idle** (màu xanh).

---

## 8. Cấu hình DNS

### Trong Cloud DNS

```bash
# Tạo managed zone (nếu chưa có)
gcloud dns managed-zones create example-zone \
  --dns-name=example.com. \
  --description="My domain"

# Thêm A record
gcloud dns record-sets create app.example.com. \
  --zone=example-zone \
  --type=A \
  --ttl=300 \
  --rrdatas=<GCE_EXTERNAL_IP>
```

### Cập nhật nameservers tại domain registrar

```bash
# Xem nameservers của Cloud DNS zone
gcloud dns managed-zones describe example-zone \
  --format="get(nameServers)"
```

Copy 4 nameservers này vào domain registrar (Namecheap, GoDaddy, v.v.)

> DNS propagation thường mất 5–30 phút. Kiểm tra: `nslookup app.example.com`

---

## 9. Luồng CI/CD

```
git push main
    │
    ▼
GitHub Actions trigger
    │
    ├─ Checkout source
    │
    ├─ Set metadata
    │   VERSION  = package.json → version
    │   BUILD_TIME = $(date -u)
    │   SHORT_SHA = ${GITHUB_SHA::7}
    │
    ├─ gcloud auth configure-docker  (dùng VM Service Account)
    │
    ├─ docker build
    │   --build-arg APP_VERSION=$VERSION
    │   --build-arg BUILD_TIME=$BUILD_TIME
    │   -t asia-southeast1-docker.pkg.dev/.../gce-zero2prod:$VERSION
    │   -t asia-southeast1-docker.pkg.dev/.../gce-zero2prod:latest
    │
    ├─ docker push (versioned tag + latest)
    │
    ├─ docker stop gce-zero2prod || true
    ├─ docker rm   gce-zero2prod || true
    ├─ docker run -d --name gce-zero2prod -p 3000:3000 ...
    │
    ├─ curl localhost:3000/health → 200 OK ✓
    │
    └─ docker image prune -f
```

**Thời gian trung bình:** 1–2 phút từ push đến live.

---

## 10. Demo: đổi version

Đây là điểm mấu chốt của lab:

```bash
# 1. Sửa version trong package.json
vim package.json
# "version": "2.0.0"

# 2. Commit & push
git add package.json
git commit -m "bump version to 2.0.0"
git push

# 3. Vào GitHub Actions → xem pipeline chạy
# 4. Sau ~1 phút, refresh https://app.example.com → thấy Version: 2.0.0
```

**Điều hiển thị thay đổi:**

| Field | Giải thích |
|-------|-----------|
| Version | Từ `package.json` — bump để demo release |
| Build Time | Tự động lấy lúc CI build |
| Hostname | Tên GCE VM — clone VM để demo horizontal scaling |

---

## 11. API Reference

| Endpoint | Method | Response | Dùng cho |
|----------|--------|----------|---------|
| `/` | GET | HTML Dashboard | Browser |
| `/health` | GET | `200 OK` | Load balancer health check |
| `/info` | GET | JSON | Monitoring, scripts |

### `GET /info` Response

```json
{
  "app": "gce-zero2prod",
  "version": "1.0.0",
  "buildTime": "2026-02-26T08:00:00Z",
  "hostname": "gce-instance-1",
  "uptime": "3600s",
  "nodeVersion": "v20.11.0"
}
```

---

## 12. Troubleshooting

### Runner không nhận job

```bash
# SSH vào VM, kiểm tra runner service
sudo /home/$USER/actions-runner/svc.sh status
sudo journalctl -u actions.runner.* -f

# Restart runner
sudo /home/$USER/actions-runner/svc.sh stop
sudo /home/$USER/actions-runner/svc.sh start
```

### Docker permission denied

```bash
# Cần log out và log in lại sau khi thêm vào group docker
# Hoặc dùng newgrp để áp dụng ngay
newgrp docker
```

### Nginx 502 Bad Gateway

```bash
# Kiểm tra container có đang chạy không
docker ps
docker logs gce-zero2prod --tail 50

# Kiểm tra port
curl -v localhost:3000/health
```

### SSL cert không cấp được

```bash
# Đảm bảo domain đã trỏ về IP của VM
nslookup app.example.com

# Thử cấp lại cert
sudo certbot certonly --nginx -d app.example.com

# Kiểm tra cert
sudo certbot certificates
```

### Artifact Registry: permission denied

```bash
# Kiểm tra Service Account có role artifactregistry.writer chưa
gcloud projects get-iam-policy YOUR_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.role:artifactregistry.writer"

# Cấu hình lại Docker auth
gcloud auth configure-docker asia-southeast1-docker.pkg.dev --quiet
```

### Xem log pipeline chi tiết

```bash
# Log của job đang chạy
sudo journalctl -u actions.runner.* --since "5 minutes ago" -f
```

---

## Cấu trúc project

```
gce-zero2prod/
├── app.js                          ← Express server + dashboard UI
├── package.json                    ← version field = app version
├── Dockerfile                      ← ARG APP_VERSION, ARG BUILD_TIME
├── .env.example                    ← Template biến môi trường
├── .gitignore
├── README.md
├── .github/
│   └── workflows/
│       └── deploy.yml              ← CI/CD pipeline
├── nginx/
│   └── app.conf                    ← Reverse proxy + SSL config
└── scripts/
    └── setup-gce.sh                ← One-time GCE VM setup
```
