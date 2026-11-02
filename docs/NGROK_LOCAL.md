# 로컬 + ngrok Slack Interactivity 설정

> orchestrator(:3001)만 ngrok으로 공개합니다. talentfolio는 `localhost:3000` 로컬 실행.

## 터미널 4개 (실행 순서)

```powershell
# 1) Redis (Docker)
docker start redis

# 2) mcp-server — orchestrator보다 먼저
cd C:\ClaudeWorkspace\jd-fit-analyzer\mcp-server
npm run dev

# 3) orchestrator
cd C:\ClaudeWorkspace\jd-fit-analyzer\orchestrator
npm run dev

# 4) ngrok — orchestrator 기동 후 (더블클릭 OK)
cd C:\ClaudeWorkspace\jd-fit-analyzer
.\scripts\start-ngrok.bat
# 또는 PowerShell: .\scripts\start-ngrok.ps1

# 5) talentfolio (별도)
cd C:\ClaudeWorkspace\test1-main\talentfolio
npm run dev
```

## ngrok 최초 1회 (계정)

1. https://ngrok.com 가입 (무료)
2. https://dashboard.ngrok.com/get-started/your-authtoken 에서 토큰 복사
3. 터미널:
   ```powershell
   ngrok config add-authtoken YOUR_TOKEN_HERE
   ```

## `.env.local` (jd-fit-analyzer)

스크립트가 `SLACK_INTERACTIVITY_URL` 은 자동 갱신합니다. **직접 넣을 것:**

```env
SLACK_SIGNING_SECRET=xxxxxxxx          # Slack App > Basic Information
SLACK_INTERACTIVITY_URL=https://....ngrok-free.app/api/slack/interactivity
TALENTFOLIO_URL=http://localhost:3000
```

→ **mcp-server + orchestrator 재시작** (env는 mcp-server가 읽음)

## Slack App 설정

1. https://api.slack.com/apps → **SLACK_BOT_TOKEN 과 같은 앱**
2. **Interactivity & Shortcuts** → **On**
3. **Request URL** = `SLACK_INTERACTIVITY_URL` 과 동일
4. 저장 시 Slack이 URL 검증 → orchestrator + ngrok 이 **떠 있어야** 함

## 테스트

1. `http://localhost:3000/sourcing` → 승인 요청 보내기
2. Slack 채널에 ✅/❌ 버튼 메시지 확인
3. 버튼 클릭 → orchestrator 로그 + `/sourcing/review` 상태 변경

## 주의

- ngrok 무료 URL은 **세션마다 바뀔 수 있음** → 바뀔 때마다 Slack Request URL + `.env.local` + 서버 재시작
- ngrok 끄면 Slack 버튼 **즉시 불가** (웹 `/sourcing/review` 승인은 계속 가능)
- Vercel 배포 웹은 이 설정과 **무관** (로컬 talentfolio + 로컬 orchestrator 전용)
