# 대전방 입장 알림 배포 설정

서버는 `FIREBASE_SERVICE_ACCOUNT_JSON` 환경 변수가 설정되면 Firebase Cloud Messaging으로 방 입장 알림을 발송합니다.

1. Firebase에 Android 패키지 `com.homerunbaseball.game`을 등록합니다.
2. Firebase 서비스 계정 JSON을 발급한 뒤 Base64 한 줄 문자열로 변환합니다.
3. Render 서비스의 Environment에 `FIREBASE_SERVICE_ACCOUNT_JSON`으로 저장합니다.
4. 최신 커밋을 다시 배포합니다.

서비스 계정 JSON과 Base64 값은 저장소에 커밋하지 않습니다. Android 클라이언트 설정 방법과 실제 기기 점검 순서는 상위 폴더의 `MATCH_NOTIFICATION_SETUP.md`를 따릅니다.

공개방과 비공개방은 상대가 입장하기 전까지 모두 1시간 동안 유지됩니다.
