# Managed interviews API contract

The role selection screen is at `/`; legacy vital rooms are at `/vital`. UI routes: `/company?mode=human|ai`,
`/company/invitation?id=...` (issued invitation and copy controls), `/company/report?id=...` (individual evidence and human review),
`/interviews/join?code=...`, `/interviews/session?id=...&host=1` (host) or candidate session restored in browser.
API base is same-origin by default; Next.js proxies hiring REST and WebSocket to `BACKEND_INTERNAL_URL`. An explicit `NEXT_PUBLIC_API_URL` overrides the browser base. All API routes below under `/api/hiring`.

`GET /sharing` is employer-authenticated and reads the trusted `HIRING_PUBLIC_URL` deployment setting or the launcher's `.sharing/url.txt` (override `HIRING_SHARING_URL_FILE`; empty disables file discovery). It returns `{public_origin,reachable,temporary,reason}`. Only a bounded HTTPS identity probe matching `GET /sharing/identity` on this API process makes the URL usable; no client-controlled URL is accepted. The identity is public and carries no authentication authority. Success is cached for 10 seconds and failure for 2 seconds; configuration changes invalidate the cache key. Invitation UI uses this public origin for applicant links while keeping employer session/auth/API traffic on its original origin. No private/local URL is offered as an external invitation. A directly hosted public HTTPS UI can fall back to its own origin.
Bearer employer tokens use sessionStorage `hiring_employer_token`; candidate tokens use sessionStorage `hiring_candidate_<invitation id>`.
JSON snake_case. Errors use FastAPI detail containing user readable Japanese string.

## REST
- POST `/auth/register` {company_name,email,password}; POST `/auth/login` {email,password} => {token,company:{id,name,email}}
- GET `/auth/me` => company; POST `/auth/logout` => {ok:true} (Bearer)
- GET `/templates` => {templates:Template[]}; POST `/templates` {title,job_title,mode:'human'|'ai',duration_minutes,questions:string[],criteria:string[]} => Template
- GET `/invitations` => {invitations:Invitation[]}; POST `/templates/{id}/invitations` {candidate_name,opens_at: ISO|null,expires_at:ISO} => Invitation
- POST `/invitations/{id}/revoke` => Invitation
- GET `/invitations/{id}` => Session (employer)
- POST `/invitations/{id}/admit` => Session (employer; human only)
- POST `/invitations/{id}/finish` => Session (employer; idempotent)
- POST `/invitations/{id}/review` {decision:'pending'|'advance'|'hold'|'reject',notes} => Session
- POST `/invitations/{id}/report` => Session (generate/retry report on completed)
- POST `/join/lookup` {code} => {id,company_name,title,job_title,mode,duration_minutes,opens_at,expires_at,status,ai_available:boolean}
- POST `/join/start` {code,name,consent:true,resume_token?:string} => {token,session:Session}; new candidate claim atomic, second claim denied; valid same token resumes (name may be empty on resume).
- GET `/session/{id}` => Session (candidate token; employer also supported)
- POST `/session/{id}/answer` {text,request_id,expected_turn_id} => Session (candidate AI; idempotent and concurrency checked)
- POST `/session/{id}/finish` => Session (candidate AI; idempotent)
- POST `/session/{id}/feedback` => Session (owning candidate or employer; completed interviews only; regenerate shared feedback without changing the private employer report)
- POST `/session/{id}/speech` {turn_id} => audio/mpeg (owning candidate, active AI interview, latest unanswered AI question only); HTTP503 permits browser speech fallback. Client text is never accepted. Authorization and current turn are rechecked after generation; Cache-Control: no-store.

Template: {id,title,job_title,mode,duration_minutes,questions,criteria,created_at}
Invitation: {id,template_id,code,candidate_name,opens_at,expires_at,status,created_at,title,job_title,mode,duration_minutes,decision}
status: invited | waiting | in_progress | completed | revoked (expired derived)
Session: {invitation:Invitation,template:Template,transcript:Turn[],report:Report|null,feedback:Feedback|null,feedback_processing:boolean,interview_progress:{question_index,question_count,follow_up_depth,max_follow_ups,answered_questions}|null,review:{decision,notes},started_at:string|null,ended_at:string|null,deadline_at:string|null,ai_available:boolean}
Candidate Session MUST omit private criteria (empty array), report null, review {decision:'pending',notes:''}; no invitation code needed in candidate snapshot.
Creation routes return HTTP201. Session also includes `processing:boolean` for durable pending AI answers; Turn includes `source:'ai'|'local'|'human'`. Resume accepts an empty name only with valid stored token. Input answers max6000 characters, duration5–120min.
Turn: {id,role:'interviewer'|'candidate'|'ai',text,created_at,question_index:number}
Report: {source:'ai'|'local',summary,items:[{criterion,summary,evidence:[{turn_id,quote}],follow_up}],generated_at}
Feedback: {version:1,source:'ai'|'local',generated_at,summary,strengths:FeedbackPoint[],improvements:FeedbackPoint[],question_reviews:[{question_index,question,summary,evidence:[{turn_id,quote}],strengths:string[],improvements:string[],answer_outline:string[]}],practice_plan:string[]}
FeedbackPoint: {title,observation,evidence:[{turn_id,quote}],suggestion}
Shared feedback excludes employer criteria, private notes/decisions and biometrics. Follow-up answers belong to the same primary-question review. Existing completed interviews get a local review immediately; explicit regeneration persists a new review. Separate reservations coalesce concurrent regeneration. Employer report regeneration updates both the private report and shared feedback.

## Engine (backend/interview_ai.py)
`async next_question(template:dict, transcript:list[dict]) -> dict` returns {text,question_index,is_follow_up,source}; questions indexed from 0. `interview_questions.py` controls scheduling, with at most 3 follow-ups per primary question, adapting to the current answer, covered topics, question type and remaining time. Refusal advances immediately; repeated unavailable examples advance after one alternative prompt. The provider may reword a follow-up but cannot change the schedule. Return text='' when complete.
`async build_report(template:dict, transcript:list[dict]) -> dict` returns Report, evidence must be exact candidate quote and valid turn id. Local fallback must honestly describe rule based grouping, no score/inferred traits.
`async build_feedback(template:dict, transcript:list[dict]) -> dict` delegates to `interview_feedback.py` and returns shared Feedback. It verifies exact candidate quotes, matching question groups and bounded fields; invalid provider output falls back to local feedback. Fill-in answer outlines distinguish past experience, motivation and future plans. No invented achievements, scores or inferred traits.
`ai_available() -> bool` reads OPENAI_API_KEY. OPENAI_INTERVIEW_MODEL defaults to `gpt-4o-mini`. Provider payload excludes name/vital fields, requests use store:false and bounded timeout/input/output. Responses text.format JSON schema follows https://developers.openai.com/api/docs/guides/structured-outputs.

## Managed human websocket
`/ws/hiring/{invitation_id}` first message `{type:'join',token}`. Server authorizes employer owner or candidate token; candidate waits for employer admit endpoint.
Server `{type:'state',session:Session,peers:[{role:'interviewer'|'candidate',name}]}`; candidate always gets redacted snapshot.
Client `{type:'signal',data:{...}}` relayed to admitted peer as `{type:'signal',data,role}`. Browser WebRTC interviewer creates offer when both peers admitted; reconnect resets peer.
Client `{type:'transcript',text,request_id}` persists authenticated speaker and broadcasts `{type:'state',...}`. REST state poll allowed to discover admission/end. No signals/transcripts while waiting. One socket per role; reconnect replaces old socket.
Saved transcript acknowledgement is `{type:'transcript_saved',request_id}`. Errors include `{type:'error',message,status,request_id?}`. Server sends up-to-date state before forwarding signaling to prevent admission ordering races.
For live human-interview vitals, each participant opts in using `{type:'vital_consent',enabled:true,save_summary:true}` after admission; state peers include `client_id` (authenticated role) and `vital_consent`. The existing camera stream sends bounded JPEG `{type:'frame',image_base64}` at 20fps. The server computes metrics and sends `{type:'vitals',client_id,role,name,vitals}` at up to 5Hz. It accepts no client-calculated BPM or stress. `{type:'vitals_clear',client_id,role}` withdraws a participant's live data on consent-off, leaving, timeout, or session end. Frames are transient. Only the explicit `save_summary:true` flag allows valid computed metrics to be persisted at most once per second per role; legacy live-only consent never saves metrics. Completed session snapshots contain `vital_summary`, with candidates restricted to their own metrics. No metrics enter AI inputs or hiring assessments. Frames are capped at 128KB encoded / 640px side / 307200 pixels, 25fps accepted, two workers, and three seconds processing wait. Authorization is checked before processing and again at broadcast. Frontend history is capped at 300 samples and cleared on sharing withdrawal/disconnection; readings expire after eight seconds without updates.

Human transcription uses the current microphone and browser recognition, independently opted in by each participant. Final text uses the existing authenticated/idempotent transcript message; a per-session/per-role queue in sessionStorage retries unacknowledged requests. Stop transcription and wait for acknowledgements before finishing the interview. Server state also supplies authenticated ICE settings; `HIRING_TURN_URLS` and `HIRING_TURN_SECRET` generate short-lived coturn-compatible credentials without exposing the shared secret.

AI turn-taking: the initial `面接を開始` gesture prepares microphone permission and question playback. Actual playback completion begins Japanese SpeechRecognition automatically. Natural recognition endings restart during the same answer. `回答を完了` calls recognition.stop(), waits for final results/onend (bounded fallback), retains interim text, then submits one idempotent answer. The next saved AI question plays automatically, followed by automatic listening. Playback/recognition are mutually exclusive; navigation, expiry and completion stop both. Unsupported or denied recognition leaves text entry available.
REST/auth/persistence live in `backend/hiring.py`, WebSocket signaling in `backend/hiring_live.py`, and question/report generation in `backend/interview_ai.py`.
Question speech lives in `backend/interview_speech.py`. OPENAI_INTERVIEW_TTS_MODEL defaults to gpt-4o-mini-tts; OPENAI_INTERVIEW_TTS_VOICE defaults to marin. Provider output is bounded, concurrent generation is limited, repeated requests for the same question are coalesced, and a bounded memory-only cache expires after five minutes. No audio files are stored.
