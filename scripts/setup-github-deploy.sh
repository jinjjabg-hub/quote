#!/usr/bin/env bash
# GitHub Actions 자동 배포 1회 설정 (Google Cloud Shell 에서 실행)
#   curl -fsSL https://raw.githubusercontent.com/jinjjabg-hub/quote/main/scripts/setup-github-deploy.sh | bash
#
# 하는 일 (여러 번 실행해도 안전, 이미 된 것은 건너뜀)
#   1. 필요한 API 켜기
#   2. 배포 전용 계정 github-deploy 만들기 + 최소 권한
#      - 시크릿은 "있는지·누가 읽는지"만 조회 (값 읽기·수정·삭제 권한 없음)
#   3. 함수 실행 계정이 시크릿 3개를 읽을 수 있게 (시크릿 값은 건드리지 않음)
#   4. GitHub(jinjjabg-hub/quote 의 main 브랜치)만 배포 계정을 쓸 수 있게 연결 (Workload Identity, 키 파일 없음)
set -euo pipefail

PROJECT=quote-640f4
REPO=jinjjabg-hub/quote
SA_NAME=github-deploy
POOL=github
PROVIDER=github-quote
SECRETS=(JUSO_SEARCH_KEY JUSO_DETAIL_KEY BLD_KEY)

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  ✓ %s\n' "$1"; }

gcloud config set project "$PROJECT" >/dev/null 2>&1
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
RUNTIME_SA="$PN-compute@developer.gserviceaccount.com"   # 2세대 함수 기본 실행 계정
APPENGINE_SA="$PROJECT@appspot.gserviceaccount.com"     # firebase-tools 가 배포 전에 actAs 권한을 검사하는 계정 (13~15.x 고정)

say "1/4 API 켜기"
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  eventarc.googleapis.com pubsub.googleapis.com firebase.googleapis.com --quiet
ok "API"

say "2/4 배포 전용 계정 ($SA)"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --display-name="GitHub Actions 함수 배포" --quiet
# 시크릿 조회 전용 맞춤 역할: 값(payload)을 읽는 secretmanager.versions.access 는 넣지 않는다
ROLE_ID=firebaseSecretChecker
PERMS=secretmanager.secrets.get,secretmanager.secrets.getIamPolicy,secretmanager.versions.get,secretmanager.versions.list
gcloud iam roles describe "$ROLE_ID" --project="$PROJECT" >/dev/null 2>&1 \
  || gcloud iam roles create "$ROLE_ID" --project="$PROJECT" --title="Firebase 배포: 시크릿 확인만" \
       --description="시크릿 존재·버전·IAM 조회만. 값 읽기·수정 불가" --permissions="$PERMS" --stage=GA --quiet >/dev/null
for ROLE in roles/cloudfunctions.admin roles/run.admin roles/serviceusage.serviceUsageConsumer roles/firebase.viewer \
            "projects/$PROJECT/roles/$ROLE_ID"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$ROLE" --condition=None --quiet >/dev/null
  ok "$ROLE"
done
# 함수 실행 계정으로 배포할 수 있게 (그 계정 하나에만)
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$SA" \
  --role=roles/iam.serviceAccountUser --quiet >/dev/null
ok "roles/iam.serviceAccountUser ($RUNTIME_SA 에만)"
# firebase-tools 는 함수 종류와 상관없이 App Engine 기본 계정의 actAs 권한을 먼저 검사한다 (없으면 배포 중단)
if gcloud iam service-accounts describe "$APPENGINE_SA" >/dev/null 2>&1; then
  gcloud iam service-accounts add-iam-policy-binding "$APPENGINE_SA" --member="serviceAccount:$SA" \
    --role=roles/iam.serviceAccountUser --quiet >/dev/null
  ok "roles/iam.serviceAccountUser ($APPENGINE_SA 에만, 배포 전 검사용)"
fi
# 2세대 함수는 기본 실행 계정으로 빌드한다
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/cloudbuild.builds.builder --condition=None --quiet >/dev/null
ok "빌드 권한 ($RUNTIME_SA)"

say "3/4 함수가 시크릿을 읽을 수 있게 (값은 그대로)"
for S in "${SECRETS[@]}"; do
  if ! gcloud secrets describe "$S" >/dev/null 2>&1; then
    echo "  ✗ 시크릿 $S 이 없습니다. 이름을 확인하세요. (이 스크립트는 시크릿을 만들지 않습니다)"; exit 1
  fi
  gcloud secrets add-iam-policy-binding "$S" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  ok "$S"
done

say "4/4 GitHub 연결 (Workload Identity, 키 파일 없음)"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions" --quiet
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
       --display-name="jinjjabg-hub/quote" --issuer-uri="https://token.actions.githubusercontent.com" \
       --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
       --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'" --quiet
gcloud iam service-accounts add-iam-policy-binding "$SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" \
  --quiet >/dev/null
ok "$REPO (main 브랜치만)"

printf '\n\033[1;32m✅ 설정 완료. 아래 한 줄을 복사해서 Claude 에게 보내주세요 (비밀값 아님):\033[0m\n\n'
echo "GCP_WIF_PROVIDER=projects/$PN/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo
