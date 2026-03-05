-- Chạy một lần khi khởi tạo database
-- gcloud sql connect cloudrun-zero2prod-db --user=app_user --database=zero2prod

CREATE TABLE IF NOT EXISTS deployments (
  id          SERIAL       PRIMARY KEY,
  version     VARCHAR(50)  NOT NULL,
  commit_sha  VARCHAR(10)  NOT NULL,
  build_time  TIMESTAMPTZ  NOT NULL,
  deployed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status      VARCHAR(20)  NOT NULL DEFAULT 'success'
);

-- Index để query nhanh theo thời gian
CREATE INDEX IF NOT EXISTS idx_deployments_deployed_at
  ON deployments (deployed_at DESC);
