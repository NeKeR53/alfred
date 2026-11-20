// @generated par `cargo run --manifest-path src-tauri/codegen/Cargo.toml` depuis
// `src-tauri/schemas/codex` : ne pas éditer à la main.
#![allow(clippy::all, clippy::pedantic, dead_code, unused_imports, irrefutable_let_patterns, unreachable_pub)]
/**A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).

IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.*/
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
#[serde(transparent)]
pub struct AbsolutePathBuf(pub ::std::string::String);
impl ::std::ops::Deref for AbsolutePathBuf {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<AbsolutePathBuf> for ::std::string::String {
    fn from(value: AbsolutePathBuf) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::string::String> for AbsolutePathBuf {
    fn from(value: ::std::string::String) -> Self {
        Self(value)
    }
}
impl ::std::fmt::Display for AbsolutePathBuf {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
impl ::std::str::FromStr for AbsolutePathBuf {
    type Err = ::std::convert::Infallible;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.to_string()))
    }
}
///Returned when `turn/start` or `turn/steer` is submitted while the current active turn cannot accept same-turn steering, for example `/review` or manual `/compact`.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ActiveTurnNotSteerableCodexErrorInfo {
    #[serde(rename = "activeTurnNotSteerable")]
    pub active_turn_not_steerable: ActiveTurnNotSteerableCodexErrorInfoActiveTurnNotSteerable,
}
///`ActiveTurnNotSteerableCodexErrorInfoActiveTurnNotSteerable`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ActiveTurnNotSteerableCodexErrorInfoActiveTurnNotSteerable {
    #[serde(rename = "turnKind")]
    pub turn_kind: NonSteerableTurnKind,
}
///`AgentMessageDelivery`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum AgentMessageDelivery {
    #[serde(rename = "async")]
    Async,
}
impl ::std::fmt::Display for AgentMessageDelivery {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Async => f.write_str("async"),
        }
    }
}
impl ::std::str::FromStr for AgentMessageDelivery {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "async" => Ok(Self::Async),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for AgentMessageDelivery {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AgentMessageDelivery {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`AgentMessageDeltaNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct AgentMessageDeltaNotification {
    pub delta: ::std::string::String,
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///A presentation instruction for Chat to apply to this answer when recovering history.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct AgentMessageDisplay {
    ///Unknown actions must be left for the producing client to handle.
    pub action: ::std::string::String,
    #[serde(
        rename = "blockType",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub block_type: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "checkTrustedContacts",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub check_trusted_contacts: ::std::option::Option<bool>,
    #[serde(
        rename = "cyberTrustedAccess",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub cyber_trusted_access: ::std::option::Option<bool>,
}
///`AgentMessageModeration`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct AgentMessageModeration {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub display: ::std::option::Option<AgentMessageDisplay>,
    pub moderated: bool,
}
///`AgentMessageThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum AgentMessageThreadItemType {
    #[serde(rename = "agentMessage")]
    AgentMessage,
}
impl ::std::fmt::Display for AgentMessageThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::AgentMessage => f.write_str("agentMessage"),
        }
    }
}
impl ::std::str::FromStr for AgentMessageThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "agentMessage" => Ok(Self::AgentMessage),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for AgentMessageThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AgentMessageThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`AgentPath`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
#[serde(transparent)]
pub struct AgentPath(pub ::std::string::String);
impl ::std::ops::Deref for AgentPath {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<AgentPath> for ::std::string::String {
    fn from(value: AgentPath) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::string::String> for AgentPath {
    fn from(value: ::std::string::String) -> Self {
        Self(value)
    }
}
impl ::std::fmt::Display for AgentPath {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
impl ::std::str::FromStr for AgentPath {
    type Err = ::std::convert::Infallible;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.to_string()))
    }
}
///Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ApprovalsReviewer {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "auto_review")]
    AutoReview,
    #[serde(rename = "guardian_subagent")]
    GuardianSubagent,
}
impl ::std::fmt::Display for ApprovalsReviewer {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::User => f.write_str("user"),
            Self::AutoReview => f.write_str("auto_review"),
            Self::GuardianSubagent => f.write_str("guardian_subagent"),
        }
    }
}
impl ::std::str::FromStr for ApprovalsReviewer {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "user" => Ok(Self::User),
            "auto_review" => Ok(Self::AutoReview),
            "guardian_subagent" => Ok(Self::GuardianSubagent),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ApprovalsReviewer {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ApprovalsReviewer {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`AskForApproval`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub enum AskForApproval {
    #[serde(rename = "untrusted")]
    Untrusted,
    #[serde(rename = "on-request")]
    OnRequest,
    #[serde(rename = "never")]
    Never,
    #[serde(rename = "granular")]
    Granular {
        mcp_elicitations: bool,
        #[serde(default)]
        request_permissions: bool,
        rules: bool,
        sandbox_approval: bool,
        #[serde(default)]
        skill_approval: bool,
    },
}
///`AsyncUserInputQuestion`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AsyncUserInputQuestion {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub options: ::std::option::Option<::std::vec::Vec<::std::string::String>>,
    pub title: ::std::string::String,
}
///`AudioUserInput`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum AudioUserInput {
    Variant0 {
        #[serde(rename = "type")]
        type_: AudioUserInputType,
        url: ::std::string::String,
    },
    Variant1 {
        #[serde(rename = "fileId")]
        file_id: ::std::string::String,
        #[serde(rename = "type")]
        type_: AudioUserInputType,
    },
}
///`AudioUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum AudioUserInputType {
    #[serde(rename = "audio")]
    Audio,
}
impl ::std::fmt::Display for AudioUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Audio => f.write_str("audio"),
        }
    }
}
impl ::std::str::FromStr for AudioUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "audio" => Ok(Self::Audio),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for AudioUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AudioUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ByteRange`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ByteRange {
    pub end: u32,
    pub start: u32,
}
///`ClientInfo`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ClientInfo {
    pub name: ::std::string::String,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub title: ::std::option::Option<::std::string::String>,
    pub version: ::std::string::String,
}
/**This translation layer make sure that we expose codex error code in camel case.

When an upstream HTTP status is available (for example, from the Responses API or a provider), it is forwarded in `httpStatusCode` on the relevant `codexErrorInfo` variant.*/
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct CodexErrorInfo {
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_0: ::std::option::Option<CodexErrorInfoSubtype0>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_1: ::std::option::Option<CodexErrorInfoSubtype1>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_2: ::std::option::Option<HttpConnectionFailedCodexErrorInfo>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_3: ::std::option::Option<ResponseStreamConnectionFailedCodexErrorInfo>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_4: ::std::option::Option<ResponseStreamDisconnectedCodexErrorInfo>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_5: ::std::option::Option<ResponseTooManyFailedAttemptsCodexErrorInfo>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_6: ::std::option::Option<ActiveTurnNotSteerableCodexErrorInfo>,
    #[serde(flatten, skip_serializing_if = "::std::option::Option::is_none")]
    pub subtype_7: ::std::option::Option<CodexErrorInfoSubtype7>,
}
///`CodexErrorInfoSubtype0`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CodexErrorInfoSubtype0 {
    #[serde(rename = "contextWindowExceeded")]
    ContextWindowExceeded,
    #[serde(rename = "sessionBudgetExceeded")]
    SessionBudgetExceeded,
    #[serde(rename = "usageLimitExceeded")]
    UsageLimitExceeded,
    #[serde(rename = "rateLimitExceeded")]
    RateLimitExceeded,
    #[serde(rename = "flexUnavailable")]
    FlexUnavailable,
    #[serde(rename = "serverOverloaded")]
    ServerOverloaded,
    #[serde(rename = "modelNotFound")]
    ModelNotFound,
    #[serde(rename = "policyCapacityUnavailable")]
    PolicyCapacityUnavailable,
    #[serde(rename = "cyberPolicy")]
    CyberPolicy,
    #[serde(rename = "misalignmentPolicyViolation")]
    MisalignmentPolicyViolation,
    #[serde(rename = "tooManyDenials")]
    TooManyDenials,
    #[serde(rename = "internalServerError")]
    InternalServerError,
    #[serde(rename = "unauthorized")]
    Unauthorized,
    #[serde(rename = "badRequest")]
    BadRequest,
    #[serde(rename = "threadRollbackFailed")]
    ThreadRollbackFailed,
    #[serde(rename = "sandboxError")]
    SandboxError,
    #[serde(rename = "other")]
    Other,
}
impl ::std::fmt::Display for CodexErrorInfoSubtype0 {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ContextWindowExceeded => f.write_str("contextWindowExceeded"),
            Self::SessionBudgetExceeded => f.write_str("sessionBudgetExceeded"),
            Self::UsageLimitExceeded => f.write_str("usageLimitExceeded"),
            Self::RateLimitExceeded => f.write_str("rateLimitExceeded"),
            Self::FlexUnavailable => f.write_str("flexUnavailable"),
            Self::ServerOverloaded => f.write_str("serverOverloaded"),
            Self::ModelNotFound => f.write_str("modelNotFound"),
            Self::PolicyCapacityUnavailable => f.write_str("policyCapacityUnavailable"),
            Self::CyberPolicy => f.write_str("cyberPolicy"),
            Self::MisalignmentPolicyViolation => {
                f.write_str("misalignmentPolicyViolation")
            }
            Self::TooManyDenials => f.write_str("tooManyDenials"),
            Self::InternalServerError => f.write_str("internalServerError"),
            Self::Unauthorized => f.write_str("unauthorized"),
            Self::BadRequest => f.write_str("badRequest"),
            Self::ThreadRollbackFailed => f.write_str("threadRollbackFailed"),
            Self::SandboxError => f.write_str("sandboxError"),
            Self::Other => f.write_str("other"),
        }
    }
}
impl ::std::str::FromStr for CodexErrorInfoSubtype0 {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "contextWindowExceeded" => Ok(Self::ContextWindowExceeded),
            "sessionBudgetExceeded" => Ok(Self::SessionBudgetExceeded),
            "usageLimitExceeded" => Ok(Self::UsageLimitExceeded),
            "rateLimitExceeded" => Ok(Self::RateLimitExceeded),
            "flexUnavailable" => Ok(Self::FlexUnavailable),
            "serverOverloaded" => Ok(Self::ServerOverloaded),
            "modelNotFound" => Ok(Self::ModelNotFound),
            "policyCapacityUnavailable" => Ok(Self::PolicyCapacityUnavailable),
            "cyberPolicy" => Ok(Self::CyberPolicy),
            "misalignmentPolicyViolation" => Ok(Self::MisalignmentPolicyViolation),
            "tooManyDenials" => Ok(Self::TooManyDenials),
            "internalServerError" => Ok(Self::InternalServerError),
            "unauthorized" => Ok(Self::Unauthorized),
            "badRequest" => Ok(Self::BadRequest),
            "threadRollbackFailed" => Ok(Self::ThreadRollbackFailed),
            "sandboxError" => Ok(Self::SandboxError),
            "other" => Ok(Self::Other),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CodexErrorInfoSubtype0 {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CodexErrorInfoSubtype0 {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The workspace's inference hook explicitly denied this request.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CodexErrorInfoSubtype1 {
    #[serde(rename = "inferenceHookDenied")]
    InferenceHookDenied,
}
impl ::std::fmt::Display for CodexErrorInfoSubtype1 {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InferenceHookDenied => f.write_str("inferenceHookDenied"),
        }
    }
}
impl ::std::str::FromStr for CodexErrorInfoSubtype1 {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inferenceHookDenied" => Ok(Self::InferenceHookDenied),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CodexErrorInfoSubtype1 {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CodexErrorInfoSubtype1 {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CodexErrorInfoSubtype7`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum CodexErrorInfoSubtype7 {
    String(::std::string::String),
    Object(::serde_json::Map<::std::string::String, ::serde_json::Value>),
}
impl ::std::convert::From<::serde_json::Map<::std::string::String, ::serde_json::Value>>
for CodexErrorInfoSubtype7 {
    fn from(
        value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    ) -> Self {
        Self::Object(value)
    }
}
///`CollabAgentState`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CollabAgentState {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub message: ::std::option::Option<::std::string::String>,
    pub status: CollabAgentStatus,
}
///`CollabAgentStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CollabAgentStatus {
    #[serde(rename = "pendingInit")]
    PendingInit,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "errored")]
    Errored,
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "notFound")]
    NotFound,
}
impl ::std::fmt::Display for CollabAgentStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::PendingInit => f.write_str("pendingInit"),
            Self::Running => f.write_str("running"),
            Self::Interrupted => f.write_str("interrupted"),
            Self::Completed => f.write_str("completed"),
            Self::Errored => f.write_str("errored"),
            Self::Shutdown => f.write_str("shutdown"),
            Self::NotFound => f.write_str("notFound"),
        }
    }
}
impl ::std::str::FromStr for CollabAgentStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "pendingInit" => Ok(Self::PendingInit),
            "running" => Ok(Self::Running),
            "interrupted" => Ok(Self::Interrupted),
            "completed" => Ok(Self::Completed),
            "errored" => Ok(Self::Errored),
            "shutdown" => Ok(Self::Shutdown),
            "notFound" => Ok(Self::NotFound),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CollabAgentStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CollabAgentStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CollabAgentTool`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CollabAgentTool {
    #[serde(rename = "spawnAgent")]
    SpawnAgent,
    #[serde(rename = "sendInput")]
    SendInput,
    #[serde(rename = "resumeAgent")]
    ResumeAgent,
    #[serde(rename = "wait")]
    Wait,
    #[serde(rename = "closeAgent")]
    CloseAgent,
    #[serde(rename = "sendMessage")]
    SendMessage,
    #[serde(rename = "followupTask")]
    FollowupTask,
    #[serde(rename = "interruptAgent")]
    InterruptAgent,
    #[serde(rename = "listAgents")]
    ListAgents,
}
impl ::std::fmt::Display for CollabAgentTool {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SpawnAgent => f.write_str("spawnAgent"),
            Self::SendInput => f.write_str("sendInput"),
            Self::ResumeAgent => f.write_str("resumeAgent"),
            Self::Wait => f.write_str("wait"),
            Self::CloseAgent => f.write_str("closeAgent"),
            Self::SendMessage => f.write_str("sendMessage"),
            Self::FollowupTask => f.write_str("followupTask"),
            Self::InterruptAgent => f.write_str("interruptAgent"),
            Self::ListAgents => f.write_str("listAgents"),
        }
    }
}
impl ::std::str::FromStr for CollabAgentTool {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "spawnAgent" => Ok(Self::SpawnAgent),
            "sendInput" => Ok(Self::SendInput),
            "resumeAgent" => Ok(Self::ResumeAgent),
            "wait" => Ok(Self::Wait),
            "closeAgent" => Ok(Self::CloseAgent),
            "sendMessage" => Ok(Self::SendMessage),
            "followupTask" => Ok(Self::FollowupTask),
            "interruptAgent" => Ok(Self::InterruptAgent),
            "listAgents" => Ok(Self::ListAgents),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CollabAgentTool {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CollabAgentTool {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CollabAgentToolCallStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CollabAgentToolCallStatus {
    #[serde(rename = "inProgress")]
    InProgress,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "interrupted")]
    Interrupted,
}
impl ::std::fmt::Display for CollabAgentToolCallStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InProgress => f.write_str("inProgress"),
            Self::Completed => f.write_str("completed"),
            Self::Failed => f.write_str("failed"),
            Self::Interrupted => f.write_str("interrupted"),
        }
    }
}
impl ::std::str::FromStr for CollabAgentToolCallStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inProgress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CollabAgentToolCallStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CollabAgentToolCallStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CollabAgentToolCallThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CollabAgentToolCallThreadItemType {
    #[serde(rename = "collabAgentToolCall")]
    CollabAgentToolCall,
}
impl ::std::fmt::Display for CollabAgentToolCallThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::CollabAgentToolCall => f.write_str("collabAgentToolCall"),
        }
    }
}
impl ::std::str::FromStr for CollabAgentToolCallThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "collabAgentToolCall" => Ok(Self::CollabAgentToolCall),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CollabAgentToolCallThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CollabAgentToolCallThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Collaboration mode for a Codex session.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CollaborationMode {
    pub mode: ModeKind,
    pub settings: Settings,
}
///`CommandAction`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum CommandAction {
    ///ReadCommandAction
    #[serde(rename = "read")]
    Read {
        command: ::std::string::String,
        name: ::std::string::String,
        path: LegacyAppPathString,
    },
    ///ListFilesCommandAction
    #[serde(rename = "listFiles")]
    ListFiles {
        command: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        path: ::std::option::Option<::std::string::String>,
    },
    ///SearchCommandAction
    #[serde(rename = "search")]
    Search {
        command: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        path: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        query: ::std::option::Option<::std::string::String>,
    },
    ///UnknownCommandAction
    #[serde(rename = "unknown")]
    Unknown { command: ::std::string::String },
}
///`CommandExecutionApprovalDecision`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub enum CommandExecutionApprovalDecision {
    ///User approved the command.
    #[serde(rename = "accept")]
    Accept,
    ///User approved the command and future prompts in the same session-scoped approval cache should run without prompting.
    #[serde(rename = "acceptForSession")]
    AcceptForSession,
    ///User approved the command, and wants to apply the proposed execpolicy amendment so future matching commands can run without prompting.
    #[serde(rename = "acceptWithExecpolicyAmendment")]
    AcceptWithExecpolicyAmendment {
        execpolicy_amendment: ::std::vec::Vec<::std::string::String>,
    },
    ///User chose a persistent network policy rule (allow/deny) for this host.
    #[serde(rename = "applyNetworkPolicyAmendment")]
    ApplyNetworkPolicyAmendment { network_policy_amendment: NetworkPolicyAmendment },
    ///User denied the command. The agent will continue the turn.
    #[serde(rename = "decline")]
    Decline,
    ///User denied the command. The turn will also be immediately interrupted.
    #[serde(rename = "cancel")]
    Cancel,
}
///Distinguishes a command approval from input sent to an existing terminal.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CommandExecutionApprovalKind {
    #[serde(rename = "command")]
    Command,
    #[serde(rename = "writeStdin")]
    WriteStdin,
    ///A managed checkpoint requiring a fresh human decision. Only `accept`, `decline`, and `cancel` are valid. Requires the `requiredHumanApproval` initialize capability. This prompt does not itself start a command execution item.
    #[serde(rename = "humanCommand")]
    HumanCommand,
}
impl ::std::fmt::Display for CommandExecutionApprovalKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Command => f.write_str("command"),
            Self::WriteStdin => f.write_str("writeStdin"),
            Self::HumanCommand => f.write_str("humanCommand"),
        }
    }
}
impl ::std::str::FromStr for CommandExecutionApprovalKind {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "command" => Ok(Self::Command),
            "writeStdin" => Ok(Self::WriteStdin),
            "humanCommand" => Ok(Self::HumanCommand),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CommandExecutionApprovalKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandExecutionApprovalKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CommandExecutionOutputDeltaNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandExecutionOutputDeltaNotification {
    pub delta: ::std::string::String,
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`CommandExecutionRequestApprovalParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandExecutionRequestApprovalParams {
    /**Unique identifier for this specific approval callback.

For regular shell/unified_exec approvals, this is null.

For zsh-exec-bridge subcommand approvals, multiple callbacks can belong to one parent `itemId`, so `approvalId` is a distinct opaque callback id (a UUID) used to disambiguate routing. Stdin approvals also use a distinct callback id; inspect `kind` to distinguish them.*/
    #[serde(
        rename = "approvalId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approval_id: ::std::option::Option<::std::string::String>,
    ///The command to be executed.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub command: ::std::option::Option<::std::string::String>,
    ///Best-effort parsed command actions for friendly display.
    #[serde(
        rename = "commandActions",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub command_actions: ::std::option::Option<::std::vec::Vec<CommandAction>>,
    ///The command's working directory.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub cwd: ::std::option::Option<LegacyAppPathString>,
    ///Environment in which the command will run.
    #[serde(
        rename = "environmentId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub environment_id: ::std::option::Option<::std::string::String>,
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    ///Kind of action under review. Defaults to `command` for older servers.
    #[serde(default = "defaults::command_execution_request_approval_params_kind")]
    pub kind: CommandExecutionApprovalKind,
    ///Optional context for a managed-network approval prompt.
    #[serde(
        rename = "networkApprovalContext",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub network_approval_context: ::std::option::Option<NetworkApprovalContext>,
    ///Optional proposed execpolicy amendment to allow similar commands without prompting.
    #[serde(
        rename = "proposedExecpolicyAmendment",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub proposed_execpolicy_amendment: ::std::option::Option<
        ::std::vec::Vec<::std::string::String>,
    >,
    ///Optional proposed network policy amendments (allow/deny host) for future requests.
    #[serde(
        rename = "proposedNetworkPolicyAmendments",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub proposed_network_policy_amendments: ::std::option::Option<
        ::std::vec::Vec<NetworkPolicyAmendment>,
    >,
    ///Optional explanatory reason (e.g. request for network access).
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub reason: ::std::option::Option<::std::string::String>,
    ///Unix timestamp (in milliseconds) when this approval request started.
    #[serde(rename = "startedAtMs")]
    pub started_at_ms: i64,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`CommandExecutionRequestApprovalResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandExecutionRequestApprovalResponse {
    pub decision: CommandExecutionApprovalDecision,
}
///`CommandExecutionSource`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CommandExecutionSource {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "userShell")]
    UserShell,
    #[serde(rename = "unifiedExecStartup")]
    UnifiedExecStartup,
    #[serde(rename = "unifiedExecInteraction")]
    UnifiedExecInteraction,
}
impl ::std::fmt::Display for CommandExecutionSource {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Agent => f.write_str("agent"),
            Self::UserShell => f.write_str("userShell"),
            Self::UnifiedExecStartup => f.write_str("unifiedExecStartup"),
            Self::UnifiedExecInteraction => f.write_str("unifiedExecInteraction"),
        }
    }
}
impl ::std::str::FromStr for CommandExecutionSource {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "agent" => Ok(Self::Agent),
            "userShell" => Ok(Self::UserShell),
            "unifiedExecStartup" => Ok(Self::UnifiedExecStartup),
            "unifiedExecInteraction" => Ok(Self::UnifiedExecInteraction),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CommandExecutionSource {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandExecutionSource {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CommandExecutionStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CommandExecutionStatus {
    #[serde(rename = "inProgress")]
    InProgress,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "declined")]
    Declined,
}
impl ::std::fmt::Display for CommandExecutionStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InProgress => f.write_str("inProgress"),
            Self::Completed => f.write_str("completed"),
            Self::Failed => f.write_str("failed"),
            Self::Declined => f.write_str("declined"),
        }
    }
}
impl ::std::str::FromStr for CommandExecutionStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inProgress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "declined" => Ok(Self::Declined),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CommandExecutionStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandExecutionStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CommandExecutionThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CommandExecutionThreadItemType {
    #[serde(rename = "commandExecution")]
    CommandExecution,
}
impl ::std::fmt::Display for CommandExecutionThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::CommandExecution => f.write_str("commandExecution"),
        }
    }
}
impl ::std::str::FromStr for CommandExecutionThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "commandExecution" => Ok(Self::CommandExecution),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CommandExecutionThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandExecutionThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ContextCompactionThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ContextCompactionThreadItemType {
    #[serde(rename = "contextCompaction")]
    ContextCompaction,
}
impl ::std::fmt::Display for ContextCompactionThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ContextCompaction => f.write_str("contextCompaction"),
        }
    }
}
impl ::std::str::FromStr for ContextCompactionThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "contextCompaction" => Ok(Self::ContextCompaction),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ContextCompactionThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ContextCompactionThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Requested cyber treatment for an OpenAI model turn. Authorization and model-tier restrictions remain server-owned.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CyberAccessProgram {
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "daybreakBlue")]
    DaybreakBlue,
    #[serde(rename = "daybreakRed")]
    DaybreakRed,
}
impl ::std::fmt::Display for CyberAccessProgram {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Standard => f.write_str("standard"),
            Self::DaybreakBlue => f.write_str("daybreakBlue"),
            Self::DaybreakRed => f.write_str("daybreakRed"),
        }
    }
}
impl ::std::str::FromStr for CyberAccessProgram {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "standard" => Ok(Self::Standard),
            "daybreakBlue" => Ok(Self::DaybreakBlue),
            "daybreakRed" => Ok(Self::DaybreakRed),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CyberAccessProgram {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CyberAccessProgram {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`DynamicToolCallOutputContentItem`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum DynamicToolCallOutputContentItem {
    ///InputTextDynamicToolCallOutputContentItem
    #[serde(rename = "inputText")]
    InputText { text: ::std::string::String },
    ///InputImageDynamicToolCallOutputContentItem
    #[serde(rename = "inputImage")]
    InputImage { #[serde(rename = "imageUrl")] image_url: ::std::string::String },
    ///InputAudioDynamicToolCallOutputContentItem
    #[serde(rename = "inputAudio")]
    InputAudio { #[serde(rename = "audioUrl")] audio_url: ::std::string::String },
}
///`DynamicToolCallStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum DynamicToolCallStatus {
    #[serde(rename = "inProgress")]
    InProgress,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
}
impl ::std::fmt::Display for DynamicToolCallStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InProgress => f.write_str("inProgress"),
            Self::Completed => f.write_str("completed"),
            Self::Failed => f.write_str("failed"),
        }
    }
}
impl ::std::str::FromStr for DynamicToolCallStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inProgress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for DynamicToolCallStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DynamicToolCallStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`DynamicToolCallThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum DynamicToolCallThreadItemType {
    #[serde(rename = "dynamicToolCall")]
    DynamicToolCall,
}
impl ::std::fmt::Display for DynamicToolCallThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::DynamicToolCall => f.write_str("dynamicToolCall"),
        }
    }
}
impl ::std::str::FromStr for DynamicToolCallThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "dynamicToolCall" => Ok(Self::DynamicToolCall),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for DynamicToolCallThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DynamicToolCallThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`EncryptedContentFunctionCallOutputContentItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum EncryptedContentFunctionCallOutputContentItemType {
    #[serde(rename = "encrypted_content")]
    EncryptedContent,
}
impl ::std::fmt::Display for EncryptedContentFunctionCallOutputContentItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::EncryptedContent => f.write_str("encrypted_content"),
        }
    }
}
impl ::std::str::FromStr for EncryptedContentFunctionCallOutputContentItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "encrypted_content" => Ok(Self::EncryptedContent),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str>
for EncryptedContentFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for EncryptedContentFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`EnteredReviewModeThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum EnteredReviewModeThreadItemType {
    #[serde(rename = "enteredReviewMode")]
    EnteredReviewMode,
}
impl ::std::fmt::Display for EnteredReviewModeThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::EnteredReviewMode => f.write_str("enteredReviewMode"),
        }
    }
}
impl ::std::str::FromStr for EnteredReviewModeThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "enteredReviewMode" => Ok(Self::EnteredReviewMode),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for EnteredReviewModeThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EnteredReviewModeThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ErrorNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ErrorNotification {
    pub error: TurnError,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
    #[serde(rename = "willRetry")]
    pub will_retry: bool,
}
///`ExitedReviewModeThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ExitedReviewModeThreadItemType {
    #[serde(rename = "exitedReviewMode")]
    ExitedReviewMode,
}
impl ::std::fmt::Display for ExitedReviewModeThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ExitedReviewMode => f.write_str("exitedReviewMode"),
        }
    }
}
impl ::std::str::FromStr for ExitedReviewModeThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "exitedReviewMode" => Ok(Self::ExitedReviewMode),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ExitedReviewModeThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ExitedReviewModeThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`FileChangeApprovalDecision`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum FileChangeApprovalDecision {
    ///User approved the file changes.
    #[serde(rename = "accept")]
    Accept,
    ///User approved the file changes and future changes to the same files should run without prompting.
    #[serde(rename = "acceptForSession")]
    AcceptForSession,
    ///User denied the file changes. The agent will continue the turn.
    #[serde(rename = "decline")]
    Decline,
    ///User denied the file changes. The turn will also be immediately interrupted.
    #[serde(rename = "cancel")]
    Cancel,
}
impl ::std::fmt::Display for FileChangeApprovalDecision {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Accept => f.write_str("accept"),
            Self::AcceptForSession => f.write_str("acceptForSession"),
            Self::Decline => f.write_str("decline"),
            Self::Cancel => f.write_str("cancel"),
        }
    }
}
impl ::std::str::FromStr for FileChangeApprovalDecision {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "accept" => Ok(Self::Accept),
            "acceptForSession" => Ok(Self::AcceptForSession),
            "decline" => Ok(Self::Decline),
            "cancel" => Ok(Self::Cancel),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for FileChangeApprovalDecision {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for FileChangeApprovalDecision {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`FileChangeRequestApprovalParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct FileChangeRequestApprovalParams {
    ///[UNSTABLE] When set, the agent is asking the user to allow writes under this root for the remainder of the session (unclear if this is honored today).
    #[serde(
        rename = "grantRoot",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub grant_root: ::std::option::Option<::std::string::String>,
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    ///Optional explanatory reason (e.g. request for extra write access).
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub reason: ::std::option::Option<::std::string::String>,
    ///Unix timestamp (in milliseconds) when this approval request started.
    #[serde(rename = "startedAtMs")]
    pub started_at_ms: i64,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`FileChangeRequestApprovalResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct FileChangeRequestApprovalResponse {
    pub decision: FileChangeApprovalDecision,
}
///`FileChangeThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum FileChangeThreadItemType {
    #[serde(rename = "fileChange")]
    FileChange,
}
impl ::std::fmt::Display for FileChangeThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::FileChange => f.write_str("fileChange"),
        }
    }
}
impl ::std::str::FromStr for FileChangeThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "fileChange" => Ok(Self::FileChange),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for FileChangeThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for FileChangeThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`FileUpdateChange`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct FileUpdateChange {
    pub diff: ::std::string::String,
    pub kind: PatchChangeKind,
    pub path: ::std::string::String,
}
///`FunctionCallOutputBody`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum FunctionCallOutputBody {
    String(::std::string::String),
    Array(::std::vec::Vec<FunctionCallOutputContentItem>),
}
impl ::std::convert::From<::std::vec::Vec<FunctionCallOutputContentItem>>
for FunctionCallOutputBody {
    fn from(value: ::std::vec::Vec<FunctionCallOutputContentItem>) -> Self {
        Self::Array(value)
    }
}
///Responses API compatible content items that can be returned by a tool call. This is a subset of ContentItem with the types we support as function call outputs.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum FunctionCallOutputContentItem {
    InputTextFunctionCallOutputContentItem {
        text: ::std::string::String,
        #[serde(rename = "type")]
        type_: InputTextFunctionCallOutputContentItemType,
    },
    InputImageFunctionCallOutputContentItem(InputImageFunctionCallOutputContentItem),
    InputAudioFunctionCallOutputContentItem(InputAudioFunctionCallOutputContentItem),
    EncryptedContentFunctionCallOutputContentItem {
        encrypted_content: ::std::string::String,
        #[serde(rename = "type")]
        type_: EncryptedContentFunctionCallOutputContentItemType,
    },
}
impl ::std::convert::From<InputImageFunctionCallOutputContentItem>
for FunctionCallOutputContentItem {
    fn from(value: InputImageFunctionCallOutputContentItem) -> Self {
        Self::InputImageFunctionCallOutputContentItem(value)
    }
}
impl ::std::convert::From<InputAudioFunctionCallOutputContentItem>
for FunctionCallOutputContentItem {
    fn from(value: InputAudioFunctionCallOutputContentItem) -> Self {
        Self::InputAudioFunctionCallOutputContentItem(value)
    }
}
///`FunctionCallOutputThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum FunctionCallOutputThreadItemType {
    #[serde(rename = "functionCallOutput")]
    FunctionCallOutput,
}
impl ::std::fmt::Display for FunctionCallOutputThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::FunctionCallOutput => f.write_str("functionCallOutput"),
        }
    }
}
impl ::std::str::FromStr for FunctionCallOutputThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "functionCallOutput" => Ok(Self::FunctionCallOutput),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for FunctionCallOutputThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for FunctionCallOutputThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`GitInfo`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct GitInfo {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub branch: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "originUrl",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub origin_url: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub sha: ::std::option::Option<::std::string::String>,
}
///`HookPromptFragment`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct HookPromptFragment {
    #[serde(rename = "hookRunId")]
    pub hook_run_id: ::std::string::String,
    pub text: ::std::string::String,
}
///`HookPromptThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum HookPromptThreadItemType {
    #[serde(rename = "hookPrompt")]
    HookPrompt,
}
impl ::std::fmt::Display for HookPromptThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::HookPrompt => f.write_str("hookPrompt"),
        }
    }
}
impl ::std::str::FromStr for HookPromptThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "hookPrompt" => Ok(Self::HookPrompt),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for HookPromptThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HookPromptThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`HttpConnectionFailedCodexErrorInfo`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct HttpConnectionFailedCodexErrorInfo {
    #[serde(rename = "httpConnectionFailed")]
    pub http_connection_failed: HttpConnectionFailedCodexErrorInfoHttpConnectionFailed,
}
///`HttpConnectionFailedCodexErrorInfoHttpConnectionFailed`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct HttpConnectionFailedCodexErrorInfoHttpConnectionFailed {
    #[serde(
        rename = "httpStatusCode",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub http_status_code: ::std::option::Option<u16>,
}
///`ImageDetail`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ImageDetail {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "original")]
    Original,
}
impl ::std::fmt::Display for ImageDetail {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Auto => f.write_str("auto"),
            Self::Low => f.write_str("low"),
            Self::High => f.write_str("high"),
            Self::Original => f.write_str("original"),
        }
    }
}
impl ::std::str::FromStr for ImageDetail {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "auto" => Ok(Self::Auto),
            "low" => Ok(Self::Low),
            "high" => Ok(Self::High),
            "original" => Ok(Self::Original),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ImageDetail {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ImageDetail {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ImageGenerationFailure`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum ImageGenerationFailure {
    ///UsageLimitExceededImageGenerationFailure
    #[serde(rename = "usageLimitExceeded")]
    UsageLimitExceeded {
        #[serde(rename = "limitId")]
        limit_id: ::std::string::String,
        #[serde(
            rename = "resetsAt",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        resets_at: ::std::option::Option<i64>,
    },
}
///A local image file successfully read for this exact image-generation request.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ImageGenerationInputImage {
    pub path: AbsolutePathBuf,
    ///Lowercase SHA-256 of the file bytes read before image normalization.
    pub sha256: ::std::string::String,
}
/**Either inline generated-image data or its durable attachment-store identity.

`File` must remain first so rollouts written during the migration, which contain both an empty `result` and a `fileId`, retain the file reference when deserialized.*/
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum ImageGenerationThreadItem {
    Variant0 {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        failure: ::std::option::Option<ImageGenerationFailure>,
        #[serde(rename = "fileId")]
        file_id: ::std::string::String,
        ///Image generation identifier for the generated image, when provided by the image backend.
        #[serde(
            rename = "generationId",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        generation_id: ::std::option::Option<::std::string::String>,
        id: ::std::string::String,
        ///Observed local inputs for a completed generation, absent on older items.
        #[serde(
            rename = "inputImages",
            default,
            skip_serializing_if = "::std::vec::Vec::is_empty"
        )]
        input_images: ::std::vec::Vec<ImageGenerationInputImage>,
        #[serde(
            rename = "revisedPrompt",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        revised_prompt: ::std::option::Option<::std::string::String>,
        #[serde(
            rename = "savedPath",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        saved_path: ::std::option::Option<AbsolutePathBuf>,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        status: ::std::string::String,
        #[serde(
            rename = "transparentBackground",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        transparent_background: ::std::option::Option<bool>,
        #[serde(rename = "type")]
        type_: ImageGenerationThreadItemType,
    },
    Variant1 {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        failure: ::std::option::Option<ImageGenerationFailure>,
        ///Image generation identifier for the generated image, when provided by the image backend.
        #[serde(
            rename = "generationId",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        generation_id: ::std::option::Option<::std::string::String>,
        id: ::std::string::String,
        ///Observed local inputs for a completed generation, absent on older items.
        #[serde(
            rename = "inputImages",
            default,
            skip_serializing_if = "::std::vec::Vec::is_empty"
        )]
        input_images: ::std::vec::Vec<ImageGenerationInputImage>,
        result: ::std::string::String,
        #[serde(
            rename = "revisedPrompt",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        revised_prompt: ::std::option::Option<::std::string::String>,
        #[serde(
            rename = "savedPath",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        saved_path: ::std::option::Option<AbsolutePathBuf>,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        status: ::std::string::String,
        #[serde(
            rename = "transparentBackground",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        transparent_background: ::std::option::Option<bool>,
        #[serde(rename = "type")]
        type_: ImageGenerationThreadItemType,
    },
}
///`ImageGenerationThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ImageGenerationThreadItemType {
    #[serde(rename = "imageGeneration")]
    ImageGeneration,
}
impl ::std::fmt::Display for ImageGenerationThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ImageGeneration => f.write_str("imageGeneration"),
        }
    }
}
impl ::std::str::FromStr for ImageGenerationThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "imageGeneration" => Ok(Self::ImageGeneration),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ImageGenerationThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ImageGenerationThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ImageUserInput`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum ImageUserInput {
    Variant0 {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        detail: ::std::option::Option<ImageDetail>,
        #[serde(rename = "type")]
        type_: ImageUserInputType,
        url: ::std::string::String,
    },
    Variant1 {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        detail: ::std::option::Option<ImageDetail>,
        #[serde(rename = "fileId")]
        file_id: ::std::string::String,
        #[serde(rename = "type")]
        type_: ImageUserInputType,
    },
}
///`ImageUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ImageUserInputType {
    #[serde(rename = "image")]
    Image,
}
impl ::std::fmt::Display for ImageUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Image => f.write_str("image"),
        }
    }
}
impl ::std::str::FromStr for ImageUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "image" => Ok(Self::Image),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ImageUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ImageUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ImageViewThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ImageViewThreadItemType {
    #[serde(rename = "imageView")]
    ImageView,
}
impl ::std::fmt::Display for ImageViewThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ImageView => f.write_str("imageView"),
        }
    }
}
impl ::std::str::FromStr for ImageViewThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "imageView" => Ok(Self::ImageView),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ImageViewThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ImageViewThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Client-declared capabilities negotiated during initialize.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct InitializeCapabilities {
    ///Opt into receiving experimental API methods and fields.
    #[serde(rename = "experimentalApi", default)]
    pub experimental_api: bool,
    ///Use explicit gateway OAuth login instead of automatic browser authorization. Applies to this app-server's gateway runtime; later connections cannot undo it.
    #[serde(
        rename = "explicitGatewayOauth",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub explicit_gateway_oauth: ::std::option::Option<bool>,
    ///MCP extension settings declared by the app-server client.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub extensions: ::std::option::Option<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    >,
    /**Legacy opt-in for the `openai/form` MCP extension.

New clients should declare `openai/form` in [`Self::extensions`].*/
    #[serde(
        rename = "mcpServerOpenaiFormElicitation",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub mcp_server_openai_form_elicitation: ::std::option::Option<bool>,
    ///Exact notification method names that should be suppressed for this connection (for example `thread/started`).
    #[serde(
        rename = "optOutNotificationMethods",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub opt_out_notification_methods: ::std::option::Option<
        ::std::vec::Vec<::std::string::String>,
    >,
    ///Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
    #[serde(rename = "requestAttestation", default)]
    pub request_attestation: bool,
    ///Present `humanCommand` approvals to a person and return only a one-time decision. Requires `experimentalApi`. Pending requests can be replayed to compatible clients.
    #[serde(
        rename = "requiredHumanApproval",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub required_human_approval: ::std::option::Option<bool>,
}
///`InitializeParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct InitializeParams {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub capabilities: ::std::option::Option<InitializeCapabilities>,
    #[serde(rename = "clientInfo")]
    pub client_info: ClientInfo,
}
///`InitializeResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct InitializeResponse {
    ///Absolute path to the server's $CODEX_HOME directory.
    #[serde(rename = "codexHome")]
    pub codex_home: AbsolutePathBuf,
    ///Platform family for the running app-server target, for example `"unix"` or `"windows"`.
    #[serde(rename = "platformFamily")]
    pub platform_family: ::std::string::String,
    ///Operating system for the running app-server target, for example `"macos"`, `"linux"`, or `"windows"`.
    #[serde(rename = "platformOs")]
    pub platform_os: ::std::string::String,
    #[serde(rename = "userAgent")]
    pub user_agent: ::std::string::String,
}
///Inline audio data or an uploaded file loaded by the Responses API.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum InputAudioFunctionCallOutputContentItem {
    Variant0 {
        audio_url: ::std::string::String,
        #[serde(rename = "type")]
        type_: InputAudioFunctionCallOutputContentItemType,
    },
    Variant1 {
        file_id: ::std::string::String,
        #[serde(rename = "type")]
        type_: InputAudioFunctionCallOutputContentItemType,
    },
}
///`InputAudioFunctionCallOutputContentItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum InputAudioFunctionCallOutputContentItemType {
    #[serde(rename = "input_audio")]
    InputAudio,
}
impl ::std::fmt::Display for InputAudioFunctionCallOutputContentItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InputAudio => f.write_str("input_audio"),
        }
    }
}
impl ::std::str::FromStr for InputAudioFunctionCallOutputContentItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "input_audio" => Ok(Self::InputAudio),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for InputAudioFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for InputAudioFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`InputImageFunctionCallOutputContentItem`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum InputImageFunctionCallOutputContentItem {
    Variant0 {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        detail: ::std::option::Option<ImageDetail>,
        image_url: ::std::string::String,
        #[serde(rename = "type")]
        type_: InputImageFunctionCallOutputContentItemType,
    },
    Variant1 {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        detail: ::std::option::Option<ImageDetail>,
        file_id: ::std::string::String,
        #[serde(rename = "type")]
        type_: InputImageFunctionCallOutputContentItemType,
    },
}
///`InputImageFunctionCallOutputContentItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum InputImageFunctionCallOutputContentItemType {
    #[serde(rename = "input_image")]
    InputImage,
}
impl ::std::fmt::Display for InputImageFunctionCallOutputContentItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InputImage => f.write_str("input_image"),
        }
    }
}
impl ::std::str::FromStr for InputImageFunctionCallOutputContentItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "input_image" => Ok(Self::InputImage),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for InputImageFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for InputImageFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Canonical user-input modality tags advertised by a model.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum InputModality {
    ///Plain text turns and tool payloads.
    #[serde(rename = "text")]
    Text,
    ///Image attachments included in user turns.
    #[serde(rename = "image")]
    Image,
    ///Audio attachments included in user turns.
    #[serde(rename = "audio")]
    Audio,
}
impl ::std::fmt::Display for InputModality {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Text => f.write_str("text"),
            Self::Image => f.write_str("image"),
            Self::Audio => f.write_str("audio"),
        }
    }
}
impl ::std::str::FromStr for InputModality {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "text" => Ok(Self::Text),
            "image" => Ok(Self::Image),
            "audio" => Ok(Self::Audio),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for InputModality {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for InputModality {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`InputTextFunctionCallOutputContentItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum InputTextFunctionCallOutputContentItemType {
    #[serde(rename = "input_text")]
    InputText,
}
impl ::std::fmt::Display for InputTextFunctionCallOutputContentItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InputText => f.write_str("input_text"),
        }
    }
}
impl ::std::str::FromStr for InputTextFunctionCallOutputContentItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "input_text" => Ok(Self::InputText),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for InputTextFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for InputTextFunctionCallOutputContentItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ItemCompletedNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ItemCompletedNotification {
    ///Unix timestamp (in milliseconds) when this item lifecycle completed.
    #[serde(rename = "completedAtMs")]
    pub completed_at_ms: i64,
    ///Native content tokens for the completed assistant message, including a sampled footer. Null when unavailable. Completion telemetry is not part of the stored thread item.
    #[serde(
        rename = "contentTokenCount",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub content_token_count: ::std::option::Option<u64>,
    pub item: ThreadItem,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`ItemStartedNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ItemStartedNotification {
    pub item: ThreadItem,
    ///Unix timestamp (in milliseconds) when this item lifecycle started.
    #[serde(rename = "startedAtMs")]
    pub started_at_ms: i64,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`LegacyAppPathString`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
#[serde(transparent)]
pub struct LegacyAppPathString(pub ::std::string::String);
impl ::std::ops::Deref for LegacyAppPathString {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<LegacyAppPathString> for ::std::string::String {
    fn from(value: LegacyAppPathString) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::string::String> for LegacyAppPathString {
    fn from(value: ::std::string::String) -> Self {
        Self(value)
    }
}
impl ::std::fmt::Display for LegacyAppPathString {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
impl ::std::str::FromStr for LegacyAppPathString {
    type Err = ::std::convert::Infallible;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.to_string()))
    }
}
///`LocalAudioUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum LocalAudioUserInputType {
    #[serde(rename = "localAudio")]
    LocalAudio,
}
impl ::std::fmt::Display for LocalAudioUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::LocalAudio => f.write_str("localAudio"),
        }
    }
}
impl ::std::str::FromStr for LocalAudioUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "localAudio" => Ok(Self::LocalAudio),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for LocalAudioUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for LocalAudioUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`LocalImageUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum LocalImageUserInputType {
    #[serde(rename = "localImage")]
    LocalImage,
}
impl ::std::fmt::Display for LocalImageUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::LocalImage => f.write_str("localImage"),
        }
    }
}
impl ::std::str::FromStr for LocalImageUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "localImage" => Ok(Self::LocalImage),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for LocalImageUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for LocalImageUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`McpAppDisplayMode`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum McpAppDisplayMode {
    #[serde(rename = "inline")]
    Inline,
    #[serde(rename = "fullscreen")]
    Fullscreen,
}
impl ::std::fmt::Display for McpAppDisplayMode {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Inline => f.write_str("inline"),
            Self::Fullscreen => f.write_str("fullscreen"),
        }
    }
}
impl ::std::str::FromStr for McpAppDisplayMode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inline" => Ok(Self::Inline),
            "fullscreen" => Ok(Self::Fullscreen),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for McpAppDisplayMode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for McpAppDisplayMode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///UI resource and display preference for model invocations, captured from the tool descriptor.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct McpAppUi {
    #[serde(rename = "preferredModelDisplayMode")]
    pub preferred_model_display_mode: McpAppDisplayMode,
    #[serde(rename = "resourceUri")]
    pub resource_uri: ::std::string::String,
}
///`McpToolCallAppContext`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct McpToolCallAppContext {
    #[serde(
        rename = "actionName",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub action_name: ::std::option::Option<::std::string::String>,
    #[serde(rename = "appName", skip_serializing_if = "::std::option::Option::is_none")]
    pub app_name: ::std::option::Option<::std::string::String>,
    #[serde(rename = "connectorId")]
    pub connector_id: ::std::string::String,
    #[serde(rename = "linkId", skip_serializing_if = "::std::option::Option::is_none")]
    pub link_id: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "resourceUri",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub resource_uri: ::std::option::Option<::std::string::String>,
}
///`McpToolCallError`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct McpToolCallError {
    pub message: ::std::string::String,
}
///`McpToolCallProgressNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct McpToolCallProgressNotification {
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    pub message: ::std::string::String,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`McpToolCallResult`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct McpToolCallResult {
    pub content: ::std::vec::Vec<::serde_json::Value>,
    #[serde(rename = "_meta", skip_serializing_if = "::std::option::Option::is_none")]
    pub meta: ::std::option::Option<::serde_json::Value>,
    #[serde(
        rename = "structuredContent",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub structured_content: ::std::option::Option<::serde_json::Value>,
}
///`McpToolCallStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum McpToolCallStatus {
    #[serde(rename = "inProgress")]
    InProgress,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
}
impl ::std::fmt::Display for McpToolCallStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InProgress => f.write_str("inProgress"),
            Self::Completed => f.write_str("completed"),
            Self::Failed => f.write_str("failed"),
        }
    }
}
impl ::std::str::FromStr for McpToolCallStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inProgress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for McpToolCallStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for McpToolCallStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`McpToolCallThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum McpToolCallThreadItemType {
    #[serde(rename = "mcpToolCall")]
    McpToolCall,
}
impl ::std::fmt::Display for McpToolCallThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::McpToolCall => f.write_str("mcpToolCall"),
        }
    }
}
impl ::std::str::FromStr for McpToolCallThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "mcpToolCall" => Ok(Self::McpToolCall),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for McpToolCallThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for McpToolCallThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`MemoryCitation`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct MemoryCitation {
    pub entries: ::std::vec::Vec<MemoryCitationEntry>,
    #[serde(rename = "threadIds")]
    pub thread_ids: ::std::vec::Vec<::std::string::String>,
}
///`MemoryCitationEntry`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct MemoryCitationEntry {
    #[serde(rename = "lineEnd")]
    pub line_end: u32,
    #[serde(rename = "lineStart")]
    pub line_start: u32,
    pub note: ::std::string::String,
    pub path: ::std::string::String,
}
///`MentionUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum MentionUserInputType {
    #[serde(rename = "mention")]
    Mention,
}
impl ::std::fmt::Display for MentionUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Mention => f.write_str("mention"),
        }
    }
}
impl ::std::str::FromStr for MentionUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "mention" => Ok(Self::Mention),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for MentionUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for MentionUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
/**Classifies assistant text as commentary, a partial answer, or a terminal answer.

Providers do not emit this consistently, so callers must treat `None` as "phase unknown" and keep compatibility behavior for legacy models.*/
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum MessagePhase {
    /**Mid-turn assistant text (for example preamble/progress narration).

Additional tool calls or assistant output may follow before turn completion.*/
    #[serde(rename = "commentary")]
    Commentary,
    ///Stable answer text that may be followed by more assistant output or tools.
    #[serde(rename = "partial_answer")]
    PartialAnswer,
    ///The assistant's declared terminal answer text for the current turn.
    #[serde(rename = "final_answer")]
    FinalAnswer,
}
impl ::std::fmt::Display for MessagePhase {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Commentary => f.write_str("commentary"),
            Self::PartialAnswer => f.write_str("partial_answer"),
            Self::FinalAnswer => f.write_str("final_answer"),
        }
    }
}
impl ::std::str::FromStr for MessagePhase {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "commentary" => Ok(Self::Commentary),
            "partial_answer" => Ok(Self::PartialAnswer),
            "final_answer" => Ok(Self::FinalAnswer),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for MessagePhase {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for MessagePhase {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`MisalignmentErrorDetails`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct MisalignmentErrorDetails {
    ///A substantive localized explanation is required before offering continuation.
    #[serde(
        rename = "detailedExplanation",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub detailed_explanation: ::std::option::Option<::std::string::String>,
    ///Open-ended classification; clients must accept categories added by Responses.
    #[serde(
        rename = "errorType",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub error_type: ::std::option::Option<::std::string::String>,
    ///Opaque server-issued block target. Presence alone does not enable target-based continuation.
    #[serde(
        rename = "reviewTarget",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub review_target: ::std::option::Option<::std::string::String>,
    ///Instruction to submit as the next turn's user input if continuation is confirmed.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub steer: ::std::option::Option<MisalignmentSteer>,
}
///`MisalignmentSteer`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct MisalignmentSteer {
    pub message: ::std::string::String,
}
///Initial collaboration mode to use when the TUI starts.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ModeKind {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "default")]
    Default,
}
impl ::std::fmt::Display for ModeKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Plan => f.write_str("plan"),
            Self::Default => f.write_str("default"),
        }
    }
}
impl ::std::str::FromStr for ModeKind {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "plan" => Ok(Self::Plan),
            "default" => Ok(Self::Default),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ModeKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ModeKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`Model`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Model {
    ///Deprecated: use `serviceTiers` instead.
    #[serde(
        rename = "additionalSpeedTiers",
        default,
        skip_serializing_if = "::std::vec::Vec::is_empty"
    )]
    pub additional_speed_tiers: ::std::vec::Vec<::std::string::String>,
    #[serde(
        rename = "availabilityNux",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub availability_nux: ::std::option::Option<ModelAvailabilityNux>,
    ///Null when the catalog does not provide access-program metadata.
    #[serde(
        rename = "availableAccessPrograms",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub available_access_programs: ::std::option::Option<ModelAccessPrograms>,
    #[serde(rename = "defaultReasoningEffort")]
    pub default_reasoning_effort: ReasoningEffort,
    ///Catalog default service tier id for this model, when one is configured.
    #[serde(
        rename = "defaultServiceTier",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub default_service_tier: ::std::option::Option<::std::string::String>,
    pub description: ::std::string::String,
    #[serde(rename = "displayName")]
    pub display_name: ::std::string::String,
    pub hidden: bool,
    pub id: ::std::string::String,
    #[serde(rename = "inputModalities", default = "defaults::model_input_modalities")]
    pub input_modalities: ::std::vec::Vec<InputModality>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub model: ::std::string::String,
    #[serde(
        rename = "modelSpecialty",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub model_specialty: ::std::option::Option<::std::string::String>,
    ///Multi-agent runtime declared by this model, when available.
    #[serde(
        rename = "multiAgentVersion",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub multi_agent_version: ::std::option::Option<MultiAgentVersion>,
    #[serde(
        rename = "serviceTiers",
        default,
        skip_serializing_if = "::std::vec::Vec::is_empty"
    )]
    pub service_tiers: ::std::vec::Vec<ModelServiceTier>,
    #[serde(rename = "supportedReasoningEfforts")]
    pub supported_reasoning_efforts: ::std::vec::Vec<ReasoningEffortOption>,
    ///@deprecated Always false; models no longer support personality selection.
    #[serde(rename = "supportsPersonality", default)]
    pub supports_personality: bool,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub upgrade: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "upgradeInfo",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub upgrade_info: ::std::option::Option<ModelUpgradeInfo>,
}
///Caller-specific explicit access programs advertised by model discovery.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ModelAccessPrograms {
    ///Accepted explicit selections.
    pub cyber: ::std::vec::Vec<CyberAccessProgram>,
}
///`ModelAvailabilityNux`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ModelAvailabilityNux {
    pub message: ::std::string::String,
}
///`ModelListParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct ModelListParams {
    ///Opaque pagination cursor returned by a previous call.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub cursor: ::std::option::Option<::std::string::String>,
    ///When true, include models that are hidden from the default picker list.
    #[serde(
        rename = "includeHidden",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub include_hidden: ::std::option::Option<bool>,
    ///Optional page size; defaults to a reasonable server-side value.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub limit: ::std::option::Option<u32>,
    ///List models for this configured provider instead of the app-server default.
    #[serde(
        rename = "modelProvider",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub model_provider: ::std::option::Option<::std::string::String>,
}
///`ModelListResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ModelListResponse {
    pub data: ::std::vec::Vec<Model>,
    ///Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.
    #[serde(
        rename = "nextCursor",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub next_cursor: ::std::option::Option<::std::string::String>,
}
///`ModelServiceTier`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ModelServiceTier {
    pub description: ::std::string::String,
    pub id: ::std::string::String,
    pub name: ::std::string::String,
}
///`ModelUpgradeInfo`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ModelUpgradeInfo {
    #[serde(
        rename = "migrationMarkdown",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub migration_markdown: ::std::option::Option<::std::string::String>,
    pub model: ::std::string::String,
    #[serde(
        rename = "modelLink",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub model_link: ::std::option::Option<::std::string::String>,
    ///Informational Unix timestamp for this upgrade's scheduled retirement, if known.
    #[serde(
        rename = "retirementAt",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub retirement_at: ::std::option::Option<i64>,
    #[serde(
        rename = "upgradeCopy",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub upgrade_copy: ::std::option::Option<::std::string::String>,
}
///Multi-agent runtime supported by a model.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum MultiAgentVersion {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "v1")]
    V1,
    #[serde(rename = "v2")]
    V2,
}
impl ::std::fmt::Display for MultiAgentVersion {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Disabled => f.write_str("disabled"),
            Self::V1 => f.write_str("v1"),
            Self::V2 => f.write_str("v2"),
        }
    }
}
impl ::std::str::FromStr for MultiAgentVersion {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "disabled" => Ok(Self::Disabled),
            "v1" => Ok(Self::V1),
            "v2" => Ok(Self::V2),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for MultiAgentVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for MultiAgentVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`NetworkAccess`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum NetworkAccess {
    #[serde(rename = "restricted")]
    Restricted,
    #[serde(rename = "enabled")]
    Enabled,
}
impl ::std::fmt::Display for NetworkAccess {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Restricted => f.write_str("restricted"),
            Self::Enabled => f.write_str("enabled"),
        }
    }
}
impl ::std::str::FromStr for NetworkAccess {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "restricted" => Ok(Self::Restricted),
            "enabled" => Ok(Self::Enabled),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for NetworkAccess {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for NetworkAccess {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`NetworkApprovalContext`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NetworkApprovalContext {
    pub host: ::std::string::String,
    pub protocol: NetworkApprovalProtocol,
}
///`NetworkApprovalProtocol`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum NetworkApprovalProtocol {
    #[serde(rename = "http")]
    Http,
    #[serde(rename = "https")]
    Https,
    #[serde(rename = "socks5Tcp")]
    Socks5Tcp,
    #[serde(rename = "socks5Udp")]
    Socks5Udp,
}
impl ::std::fmt::Display for NetworkApprovalProtocol {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Http => f.write_str("http"),
            Self::Https => f.write_str("https"),
            Self::Socks5Tcp => f.write_str("socks5Tcp"),
            Self::Socks5Udp => f.write_str("socks5Udp"),
        }
    }
}
impl ::std::str::FromStr for NetworkApprovalProtocol {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "http" => Ok(Self::Http),
            "https" => Ok(Self::Https),
            "socks5Tcp" => Ok(Self::Socks5Tcp),
            "socks5Udp" => Ok(Self::Socks5Udp),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for NetworkApprovalProtocol {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for NetworkApprovalProtocol {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`NetworkPolicyAmendment`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NetworkPolicyAmendment {
    pub action: NetworkPolicyRuleAction,
    pub host: ::std::string::String,
}
///`NetworkPolicyRuleAction`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum NetworkPolicyRuleAction {
    #[serde(rename = "allow")]
    Allow,
    #[serde(rename = "deny")]
    Deny,
}
impl ::std::fmt::Display for NetworkPolicyRuleAction {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Allow => f.write_str("allow"),
            Self::Deny => f.write_str("deny"),
        }
    }
}
impl ::std::str::FromStr for NetworkPolicyRuleAction {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "allow" => Ok(Self::Allow),
            "deny" => Ok(Self::Deny),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for NetworkPolicyRuleAction {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for NetworkPolicyRuleAction {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`NonSteerableTurnKind`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum NonSteerableTurnKind {
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "compact")]
    Compact,
}
impl ::std::fmt::Display for NonSteerableTurnKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Review => f.write_str("review"),
            Self::Compact => f.write_str("compact"),
        }
    }
}
impl ::std::str::FromStr for NonSteerableTurnKind {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "review" => Ok(Self::Review),
            "compact" => Ok(Self::Compact),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for NonSteerableTurnKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for NonSteerableTurnKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`PatchApplyStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum PatchApplyStatus {
    #[serde(rename = "inProgress")]
    InProgress,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "declined")]
    Declined,
}
impl ::std::fmt::Display for PatchApplyStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InProgress => f.write_str("inProgress"),
            Self::Completed => f.write_str("completed"),
            Self::Failed => f.write_str("failed"),
            Self::Declined => f.write_str("declined"),
        }
    }
}
impl ::std::str::FromStr for PatchApplyStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "inProgress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "declined" => Ok(Self::Declined),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PatchApplyStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PatchApplyStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`PatchChangeKind`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum PatchChangeKind {
    #[serde(rename = "add")]
    Add,
    #[serde(rename = "delete")]
    Delete,
    ///UpdatePatchChangeKind
    #[serde(rename = "update")]
    Update {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        move_path: ::std::option::Option<::std::string::String>,
    },
}
///Deprecated: `friendly` and `pragmatic` no longer select a style.
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum Personality {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "friendly")]
    Friendly,
    #[serde(rename = "pragmatic")]
    Pragmatic,
}
impl ::std::fmt::Display for Personality {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::None => f.write_str("none"),
            Self::Friendly => f.write_str("friendly"),
            Self::Pragmatic => f.write_str("pragmatic"),
        }
    }
}
impl ::std::str::FromStr for Personality {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "none" => Ok(Self::None),
            "friendly" => Ok(Self::Friendly),
            "pragmatic" => Ok(Self::Pragmatic),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for Personality {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for Personality {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///EXPERIMENTAL - proposed plan streaming deltas for plan items. Clients should not assume concatenated deltas match the completed plan item content.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct PlanDeltaNotification {
    pub delta: ::std::string::String,
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`PlanThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum PlanThreadItemType {
    #[serde(rename = "plan")]
    Plan,
}
impl ::std::fmt::Display for PlanThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Plan => f.write_str("plan"),
        }
    }
}
impl ::std::str::FromStr for PlanThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "plan" => Ok(Self::Plan),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PlanThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PlanThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///A non-empty reasoning effort value advertised by the model.
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct ReasoningEffort(::std::string::String);
impl ::std::ops::Deref for ReasoningEffort {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<ReasoningEffort> for ::std::string::String {
    fn from(value: ReasoningEffort) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for ReasoningEffort {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for ReasoningEffort {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReasoningEffort {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for ReasoningEffort {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`ReasoningEffortOption`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ReasoningEffortOption {
    pub description: ::std::string::String,
    #[serde(rename = "reasoningEffort")]
    pub reasoning_effort: ReasoningEffort,
}
///A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ReasoningSummary {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "concise")]
    Concise,
    #[serde(rename = "detailed")]
    Detailed,
    ///Option to disable reasoning summaries.
    #[serde(rename = "none")]
    None,
}
impl ::std::fmt::Display for ReasoningSummary {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Auto => f.write_str("auto"),
            Self::Concise => f.write_str("concise"),
            Self::Detailed => f.write_str("detailed"),
            Self::None => f.write_str("none"),
        }
    }
}
impl ::std::str::FromStr for ReasoningSummary {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "auto" => Ok(Self::Auto),
            "concise" => Ok(Self::Concise),
            "detailed" => Ok(Self::Detailed),
            "none" => Ok(Self::None),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ReasoningSummary {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReasoningSummary {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ReasoningSummaryTextDeltaNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ReasoningSummaryTextDeltaNotification {
    pub delta: ::std::string::String,
    #[serde(rename = "itemId")]
    pub item_id: ::std::string::String,
    #[serde(rename = "summaryIndex")]
    pub summary_index: i64,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`ReasoningThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ReasoningThreadItemType {
    #[serde(rename = "reasoning")]
    Reasoning,
}
impl ::std::fmt::Display for ReasoningThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Reasoning => f.write_str("reasoning"),
        }
    }
}
impl ::std::str::FromStr for ReasoningThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "reasoning" => Ok(Self::Reasoning),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ReasoningThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReasoningThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Failed to connect to the response SSE stream.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResponseStreamConnectionFailedCodexErrorInfo {
    #[serde(rename = "responseStreamConnectionFailed")]
    pub response_stream_connection_failed: ResponseStreamConnectionFailedCodexErrorInfoResponseStreamConnectionFailed,
}
///`ResponseStreamConnectionFailedCodexErrorInfoResponseStreamConnectionFailed`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct ResponseStreamConnectionFailedCodexErrorInfoResponseStreamConnectionFailed {
    #[serde(
        rename = "httpStatusCode",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub http_status_code: ::std::option::Option<u16>,
}
///The response SSE stream disconnected in the middle of a turn before completion.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResponseStreamDisconnectedCodexErrorInfo {
    #[serde(rename = "responseStreamDisconnected")]
    pub response_stream_disconnected: ResponseStreamDisconnectedCodexErrorInfoResponseStreamDisconnected,
}
///`ResponseStreamDisconnectedCodexErrorInfoResponseStreamDisconnected`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct ResponseStreamDisconnectedCodexErrorInfoResponseStreamDisconnected {
    #[serde(
        rename = "httpStatusCode",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub http_status_code: ::std::option::Option<u16>,
}
///Reached the retry limit for responses.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResponseTooManyFailedAttemptsCodexErrorInfo {
    #[serde(rename = "responseTooManyFailedAttempts")]
    pub response_too_many_failed_attempts: ResponseTooManyFailedAttemptsCodexErrorInfoResponseTooManyFailedAttempts,
}
///`ResponseTooManyFailedAttemptsCodexErrorInfoResponseTooManyFailedAttempts`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct ResponseTooManyFailedAttemptsCodexErrorInfoResponseTooManyFailedAttempts {
    #[serde(
        rename = "httpStatusCode",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub http_status_code: ::std::option::Option<u16>,
}
///`SandboxMode`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum SandboxMode {
    #[serde(rename = "read-only")]
    ReadOnly,
    #[serde(rename = "workspace-write")]
    WorkspaceWrite,
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,
}
impl ::std::fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ReadOnly => f.write_str("read-only"),
            Self::WorkspaceWrite => f.write_str("workspace-write"),
            Self::DangerFullAccess => f.write_str("danger-full-access"),
        }
    }
}
impl ::std::str::FromStr for SandboxMode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "read-only" => Ok(Self::ReadOnly),
            "workspace-write" => Ok(Self::WorkspaceWrite),
            "danger-full-access" => Ok(Self::DangerFullAccess),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SandboxMode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SandboxMode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SandboxPolicy`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum SandboxPolicy {
    #[serde(rename = "dangerFullAccess")]
    DangerFullAccess,
    ///ReadOnlySandboxPolicy
    #[serde(rename = "readOnly")]
    ReadOnly { #[serde(rename = "networkAccess", default)] network_access: bool },
    ///ExternalSandboxSandboxPolicy
    #[serde(rename = "externalSandbox")]
    ExternalSandbox {
        #[serde(
            rename = "networkAccess",
            default = "defaults::sandbox_policy_external_sandbox_network_access"
        )]
        network_access: NetworkAccess,
    },
    ///WorkspaceWriteSandboxPolicy
    #[serde(rename = "workspaceWrite")]
    WorkspaceWrite {
        #[serde(rename = "excludeSlashTmp", default)]
        exclude_slash_tmp: bool,
        #[serde(rename = "excludeTmpdirEnvVar", default)]
        exclude_tmpdir_env_var: bool,
        #[serde(rename = "networkAccess", default)]
        network_access: bool,
        #[serde(
            rename = "writableRoots",
            default,
            skip_serializing_if = "::std::vec::Vec::is_empty"
        )]
        writable_roots: ::std::vec::Vec<AbsolutePathBuf>,
    },
}
///`SessionSource`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub enum SessionSource {
    #[serde(rename = "cli")]
    Cli,
    #[serde(rename = "vscode")]
    Vscode,
    #[serde(rename = "exec")]
    Exec,
    #[serde(rename = "appServer")]
    AppServer,
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "custom")]
    Custom(::std::string::String),
    #[serde(rename = "subAgent")]
    SubAgent(SubAgentSource),
}
impl ::std::convert::From<SubAgentSource> for SessionSource {
    fn from(value: SubAgentSource) -> Self {
        Self::SubAgent(value)
    }
}
///Settings for a collaboration mode.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Settings {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub developer_instructions: ::std::option::Option<::std::string::String>,
    pub model: ::std::string::String,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub reasoning_effort: ::std::option::Option<ReasoningEffort>,
}
///`SkillDependencies`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SkillDependencies {
    pub tools: ::std::vec::Vec<SkillToolDependency>,
}
///`SkillErrorInfo`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SkillErrorInfo {
    pub message: ::std::string::String,
    pub path: ::std::string::String,
}
///`SkillInterface`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct SkillInterface {
    #[serde(
        rename = "brandColor",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub brand_color: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "defaultPrompt",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub default_prompt: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "displayName",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub display_name: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "iconLarge",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub icon_large: ::std::option::Option<AbsolutePathBuf>,
    ///Remote large icon URL from the plugin catalog.
    #[serde(
        rename = "iconLargeUrl",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub icon_large_url: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "iconSmall",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub icon_small: ::std::option::Option<AbsolutePathBuf>,
    ///Remote small icon URL from the plugin catalog.
    #[serde(
        rename = "iconSmallUrl",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub icon_small_url: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "shortDescription",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub short_description: ::std::option::Option<::std::string::String>,
}
///`SkillMetadata`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SkillMetadata {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub dependencies: ::std::option::Option<SkillDependencies>,
    pub description: ::std::string::String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub interface: ::std::option::Option<SkillInterface>,
    pub name: ::std::string::String,
    pub path: LegacyAppPathString,
    ///Owning plugin ID, matching `PluginSummary.id`, when known.
    #[serde(rename = "pluginId", skip_serializing_if = "::std::option::Option::is_none")]
    pub plugin_id: ::std::option::Option<::std::string::String>,
    pub scope: SkillScope,
    ///Legacy short_description from SKILL.md. Prefer SKILL.json interface.short_description.
    #[serde(
        rename = "shortDescription",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub short_description: ::std::option::Option<::std::string::String>,
}
///`SkillScope`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum SkillScope {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "repo")]
    Repo,
    #[serde(rename = "system")]
    System,
    #[serde(rename = "admin")]
    Admin,
}
impl ::std::fmt::Display for SkillScope {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::User => f.write_str("user"),
            Self::Repo => f.write_str("repo"),
            Self::System => f.write_str("system"),
            Self::Admin => f.write_str("admin"),
        }
    }
}
impl ::std::str::FromStr for SkillScope {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "user" => Ok(Self::User),
            "repo" => Ok(Self::Repo),
            "system" => Ok(Self::System),
            "admin" => Ok(Self::Admin),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SkillScope {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SkillScope {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SkillToolDependency`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SkillToolDependency {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub command: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub description: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub transport: ::std::option::Option<::std::string::String>,
    #[serde(rename = "type")]
    pub type_: ::std::string::String,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub url: ::std::option::Option<::std::string::String>,
    pub value: ::std::string::String,
}
///`SkillUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum SkillUserInputType {
    #[serde(rename = "skill")]
    Skill,
}
impl ::std::fmt::Display for SkillUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Skill => f.write_str("skill"),
        }
    }
}
impl ::std::str::FromStr for SkillUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "skill" => Ok(Self::Skill),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SkillUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SkillUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SkillsListEntry`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SkillsListEntry {
    pub cwd: ::std::string::String,
    pub errors: ::std::vec::Vec<SkillErrorInfo>,
    pub skills: ::std::vec::Vec<SkillMetadata>,
}
///`SkillsListParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct SkillsListParams {
    ///When empty, defaults to the current session working directory.
    #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
    pub cwds: ::std::vec::Vec<::std::string::String>,
    ///When true, bypass the skills cache and re-scan skills from disk.
    #[serde(
        rename = "forceReload",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub force_reload: ::std::option::Option<bool>,
}
///`SkillsListResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SkillsListResponse {
    pub data: ::std::vec::Vec<SkillsListEntry>,
}
///`SleepThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum SleepThreadItemType {
    #[serde(rename = "sleep")]
    Sleep,
}
impl ::std::fmt::Display for SleepThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Sleep => f.write_str("sleep"),
        }
    }
}
impl ::std::str::FromStr for SleepThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "sleep" => Ok(Self::Sleep),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SleepThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SleepThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SubAgentActivityKind`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum SubAgentActivityKind {
    #[serde(rename = "started")]
    Started,
    #[serde(rename = "interacted")]
    Interacted,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "completed")]
    Completed,
}
impl ::std::fmt::Display for SubAgentActivityKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Started => f.write_str("started"),
            Self::Interacted => f.write_str("interacted"),
            Self::Interrupted => f.write_str("interrupted"),
            Self::Completed => f.write_str("completed"),
        }
    }
}
impl ::std::str::FromStr for SubAgentActivityKind {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "started" => Ok(Self::Started),
            "interacted" => Ok(Self::Interacted),
            "interrupted" => Ok(Self::Interrupted),
            "completed" => Ok(Self::Completed),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SubAgentActivityKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SubAgentActivityKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SubAgentActivityThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum SubAgentActivityThreadItemType {
    #[serde(rename = "subAgentActivity")]
    SubAgentActivity,
}
impl ::std::fmt::Display for SubAgentActivityThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SubAgentActivity => f.write_str("subAgentActivity"),
        }
    }
}
impl ::std::str::FromStr for SubAgentActivityThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "subAgentActivity" => Ok(Self::SubAgentActivity),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SubAgentActivityThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SubAgentActivityThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SubAgentSource`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub enum SubAgentSource {
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "compact")]
    Compact,
    #[serde(rename = "memory_consolidation")]
    MemoryConsolidation,
    #[serde(rename = "thread_spawn")]
    ThreadSpawn {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        agent_nickname: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        agent_path: ::std::option::Option<AgentPath>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        agent_role: ::std::option::Option<::std::string::String>,
        depth: i32,
        parent_thread_id: ThreadId,
    },
    #[serde(rename = "other")]
    Other(::std::string::String),
}
///`TextElement`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TextElement {
    ///Byte range in the parent `text` buffer that this element occupies.
    #[serde(rename = "byteRange")]
    pub byte_range: ByteRange,
    ///Optional human-readable placeholder for the element, displayed in the UI.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub placeholder: ::std::option::Option<::std::string::String>,
}
///`TextUserInputType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum TextUserInputType {
    #[serde(rename = "text")]
    Text,
}
impl ::std::fmt::Display for TextUserInputType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Text => f.write_str("text"),
        }
    }
}
impl ::std::str::FromStr for TextUserInputType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "text" => Ok(Self::Text),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for TextUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for TextUserInputType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`Thread`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Thread {
    ///Optional random unique nickname assigned to an AgentControl-spawned sub-agent.
    #[serde(
        rename = "agentNickname",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub agent_nickname: ::std::option::Option<::std::string::String>,
    ///Optional role (agent_role) assigned to an AgentControl-spawned sub-agent.
    #[serde(
        rename = "agentRole",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub agent_role: ::std::option::Option<::std::string::String>,
    ///Version of the CLI that created the thread.
    #[serde(rename = "cliVersion")]
    pub cli_version: ::std::string::String,
    ///Unix timestamp (in seconds) when the thread was created.
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    ///Working directory captured for the thread.
    pub cwd: AbsolutePathBuf,
    ///Whether the thread is ephemeral and should not be materialized on disk.
    pub ephemeral: bool,
    ///Source thread id when this thread was created by forking another thread.
    #[serde(
        rename = "forkedFromId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub forked_from_id: ::std::option::Option<::std::string::String>,
    ///Optional Git metadata captured when the thread was created.
    #[serde(rename = "gitInfo", skip_serializing_if = "::std::option::Option::is_none")]
    pub git_info: ::std::option::Option<GitInfo>,
    ///Persisted thread history contract selected when this thread was created.
    #[serde(rename = "historyMode", default = "defaults::thread_history_mode")]
    pub history_mode: ThreadHistoryMode,
    ///Identifier for this thread. Codex-generated thread IDs are UUIDv7.
    pub id: ::std::string::String,
    ///Current configured model when loaded, otherwise the latest persisted model. Null when unavailable. This is not per-turn execution telemetry.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub model: ::std::option::Option<::std::string::String>,
    ///Model provider used for this thread (for example, 'openai').
    #[serde(rename = "modelProvider")]
    pub model_provider: ::std::string::String,
    ///Optional user-facing thread title.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub name: ::std::option::Option<::std::string::String>,
    ///Originator recorded when the thread was created, independent of its current client or executor. Null when the recorded originator is unavailable.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub originator: ::std::option::Option<::std::string::String>,
    ///The ID of the parent thread. This will only be set if this thread is a subagent.
    #[serde(
        rename = "parentThreadId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub parent_thread_id: ::std::option::Option<::std::string::String>,
    ///[UNSTABLE] Path to the thread on disk.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub path: ::std::option::Option<::std::string::String>,
    ///Usually the first user message in the thread, if available.
    pub preview: ::std::string::String,
    ///Canonical project assignment owned by app-server, if any.
    #[serde(
        rename = "projectId",
        deserialize_with = "::std::option::Option::deserialize"
    )]
    pub project_id: ::std::option::Option<::std::string::String>,
    ///Current configured reasoning effort when loaded, otherwise the latest persisted effort. Null when unset or unavailable. This is not per-turn execution telemetry.
    #[serde(
        rename = "reasoningEffort",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub reasoning_effort: ::std::option::Option<ReasoningEffort>,
    ///Unix timestamp (in seconds) used for thread recency ordering.
    #[serde(
        rename = "recencyAt",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub recency_at: ::std::option::Option<i64>,
    ///The independently persisted section selected for this thread, if any.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub section: ::std::option::Option<ThreadSection>,
    ///Unix timestamp in seconds when the thread entered its current section.
    #[serde(
        rename = "sectionEnteredAt",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub section_entered_at: ::std::option::Option<i64>,
    ///Session id shared by threads that belong to the same session tree.
    #[serde(rename = "sessionId")]
    pub session_id: ::std::string::String,
    ///Origin of the thread (CLI, VSCode, codex exec, codex app-server, etc.).
    pub source: SessionSource,
    ///Current runtime status for the thread.
    pub status: ThreadStatus,
    ///Optional analytics source classification for this thread.
    #[serde(
        rename = "threadSource",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub thread_source: ::std::option::Option<ThreadSource>,
    ///Only populated on `thread/resume`, `thread/fork`, and `thread/read` (when `includeTurns` is true) responses. For all other responses and notifications returning a Thread, the turns field will be an empty list.
    pub turns: ::std::vec::Vec<Turn>,
    ///Unix timestamp (in seconds) when the thread was last updated.
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}
///`ThreadActiveFlag`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ThreadActiveFlag {
    #[serde(rename = "waitingOnApproval")]
    WaitingOnApproval,
    #[serde(rename = "waitingOnUserInput")]
    WaitingOnUserInput,
}
impl ::std::fmt::Display for ThreadActiveFlag {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::WaitingOnApproval => f.write_str("waitingOnApproval"),
            Self::WaitingOnUserInput => f.write_str("waitingOnUserInput"),
        }
    }
}
impl ::std::str::FromStr for ThreadActiveFlag {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "waitingOnApproval" => Ok(Self::WaitingOnApproval),
            "waitingOnUserInput" => Ok(Self::WaitingOnUserInput),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ThreadActiveFlag {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ThreadActiveFlag {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ThreadHistoryMode`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ThreadHistoryMode {
    #[serde(rename = "legacy")]
    Legacy,
    #[serde(rename = "paginated")]
    Paginated,
}
impl ::std::fmt::Display for ThreadHistoryMode {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Legacy => f.write_str("legacy"),
            Self::Paginated => f.write_str("paginated"),
        }
    }
}
impl ::std::str::FromStr for ThreadHistoryMode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "legacy" => Ok(Self::Legacy),
            "paginated" => Ok(Self::Paginated),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ThreadHistoryMode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ThreadHistoryMode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ThreadId`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
#[serde(transparent)]
pub struct ThreadId(pub ::std::string::String);
impl ::std::ops::Deref for ThreadId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<ThreadId> for ::std::string::String {
    fn from(value: ThreadId) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::string::String> for ThreadId {
    fn from(value: ::std::string::String) -> Self {
        Self(value)
    }
}
impl ::std::fmt::Display for ThreadId {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
impl ::std::str::FromStr for ThreadId {
    type Err = ::std::convert::Infallible;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.to_string()))
    }
}
///A thread item and its recorded lifecycle times. The payload stays flat on the wire.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum ThreadItem {
    UserMessageThreadItem {
        #[serde(
            rename = "clientId",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        client_id: ::std::option::Option<::std::string::String>,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        content: ::std::vec::Vec<UserInput>,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: UserMessageThreadItemType,
    },
    HookPromptThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        fragments: ::std::vec::Vec<HookPromptFragment>,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: HookPromptThreadItemType,
    },
    AgentMessageThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        delivery: ::std::option::Option<AgentMessageDelivery>,
        id: ::std::string::String,
        #[serde(
            rename = "memoryCitation",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        memory_citation: ::std::option::Option<MemoryCitation>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        moderation: ::std::option::Option<AgentMessageModeration>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        phase: ::std::option::Option<MessagePhase>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        questions: ::std::option::Option<::std::vec::Vec<AsyncUserInputQuestion>>,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        text: ::std::string::String,
        #[serde(rename = "type")]
        type_: AgentMessageThreadItemType,
    },
    FunctionCallOutputThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        name: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        namespace: ::std::option::Option<::std::string::String>,
        output: FunctionCallOutputBody,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: FunctionCallOutputThreadItemType,
    },
    PlanThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        text: ::std::string::String,
        #[serde(rename = "type")]
        type_: PlanThreadItemType,
    },
    ReasoningThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        content: ::std::vec::Vec<::std::string::String>,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        summary: ::std::vec::Vec<::std::string::String>,
        #[serde(rename = "type")]
        type_: ReasoningThreadItemType,
    },
    CommandExecutionThreadItem {
        ///The command's output, aggregated from stdout and stderr.
        #[serde(
            rename = "aggregatedOutput",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        aggregated_output: ::std::option::Option<::std::string::String>,
        ///The command to be executed.
        command: ::std::string::String,
        ///A best-effort parsing of the command to understand the action(s) it will perform. This returns a list of CommandAction objects because a single shell command may be composed of many commands piped together.
        #[serde(rename = "commandActions")]
        command_actions: ::std::vec::Vec<CommandAction>,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        ///The command's working directory.
        cwd: LegacyAppPathString,
        ///The duration of the command execution in milliseconds.
        #[serde(
            rename = "durationMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        duration_ms: ::std::option::Option<i64>,
        ///The command's exit code.
        #[serde(
            rename = "exitCode",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        exit_code: ::std::option::Option<i32>,
        id: ::std::string::String,
        ///Trusted first-party plugin id when this command resolves to one plugin script.
        #[serde(
            rename = "pluginId",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        plugin_id: ::std::option::Option<::std::string::String>,
        ///Identifier for the underlying PTY process (when available).
        #[serde(
            rename = "processId",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        process_id: ::std::option::Option<::std::string::String>,
        ///Safe plugin-relative path when this command resolves to one plugin script.
        #[serde(
            rename = "scriptPath",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        script_path: ::std::option::Option<::std::string::String>,
        #[serde(default = "defaults::thread_item_command_execution_thread_item_source")]
        source: CommandExecutionSource,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        status: CommandExecutionStatus,
        #[serde(rename = "type")]
        type_: CommandExecutionThreadItemType,
    },
    FileChangeThreadItem {
        changes: ::std::vec::Vec<FileUpdateChange>,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        status: PatchApplyStatus,
        #[serde(rename = "type")]
        type_: FileChangeThreadItemType,
    },
    McpToolCallThreadItem {
        #[serde(
            rename = "appContext",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        app_context: ::std::option::Option<McpToolCallAppContext>,
        arguments: ::serde_json::Value,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        ///The duration of the MCP tool call in milliseconds.
        #[serde(
            rename = "durationMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        duration_ms: ::std::option::Option<i64>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        error: ::std::option::Option<McpToolCallError>,
        id: ::std::string::String,
        ///Legacy compatibility field; prefer `mcpAppUi.resourceUri` when available.
        #[serde(
            rename = "mcpAppResourceUri",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        mcp_app_resource_uri: ::std::option::Option<::std::string::String>,
        ///Presentation captured from the invoked descriptor; absent in older history.
        #[serde(
            rename = "mcpAppUi",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        mcp_app_ui: ::std::option::Option<McpAppUi>,
        #[serde(
            rename = "pluginId",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        plugin_id: ::std::option::Option<::std::string::String>,
        #[serde(
            rename = "readOnlyHint",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        read_only_hint: ::std::option::Option<bool>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        result: ::std::option::Option<McpToolCallResult>,
        server: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        status: McpToolCallStatus,
        tool: ::std::string::String,
        #[serde(rename = "type")]
        type_: McpToolCallThreadItemType,
    },
    DynamicToolCallThreadItem {
        arguments: ::serde_json::Value,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        #[serde(
            rename = "contentItems",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        content_items: ::std::option::Option<
            ::std::vec::Vec<DynamicToolCallOutputContentItem>,
        >,
        ///The duration of the dynamic tool call in milliseconds.
        #[serde(
            rename = "durationMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        duration_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        namespace: ::std::option::Option<::std::string::String>,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        status: DynamicToolCallStatus,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        success: ::std::option::Option<bool>,
        tool: ::std::string::String,
        #[serde(rename = "type")]
        type_: DynamicToolCallThreadItemType,
    },
    CollabAgentToolCallThreadItem {
        ///Last known status of the target agents, when available.
        #[serde(rename = "agentsStates")]
        agents_states: ::std::collections::HashMap<
            ::std::string::String,
            CollabAgentState,
        >,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        ///Unique identifier for this collab tool call.
        id: ::std::string::String,
        ///Model requested for the spawned agent, when applicable.
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        model: ::std::option::Option<::std::string::String>,
        ///Prompt text sent as part of the collab tool call, when available.
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        prompt: ::std::option::Option<::std::string::String>,
        ///Reasoning effort requested for the spawned agent, when applicable.
        #[serde(
            rename = "reasoningEffort",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        reasoning_effort: ::std::option::Option<ReasoningEffort>,
        ///Thread ID of the receiving agent, when applicable. In case of spawn operation, this corresponds to the newly spawned agent.
        #[serde(rename = "receiverThreadIds")]
        receiver_thread_ids: ::std::vec::Vec<::std::string::String>,
        ///Thread ID of the agent issuing the collab request.
        #[serde(rename = "senderThreadId")]
        sender_thread_id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        ///Current status of the collab tool call.
        status: CollabAgentToolCallStatus,
        ///Name of the collab tool that was invoked.
        tool: CollabAgentTool,
        #[serde(rename = "type")]
        type_: CollabAgentToolCallThreadItemType,
    },
    SubAgentActivityThreadItem {
        #[serde(rename = "agentPath")]
        agent_path: ::std::string::String,
        #[serde(rename = "agentThreadId")]
        agent_thread_id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        kind: SubAgentActivityKind,
        ///Resolved model at sub-agent creation; absent from older records and other activities.
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        model: ::std::option::Option<::std::string::String>,
        ///Resolved reasoning effort at sub-agent creation, when known.
        #[serde(
            rename = "reasoningEffort",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        reasoning_effort: ::std::option::Option<ReasoningEffort>,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: SubAgentActivityThreadItemType,
    },
    WebSearchThreadItem {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        action: ::std::option::Option<WebSearchAction>,
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        query: ::std::string::String,
        /**Structured search results returned out-of-band by standalone web search.

These stay as opaque JSON at the extension/app-server boundary so new result fields and result types can pass through without a Codex release.*/
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        results: ::std::option::Option<::std::vec::Vec<::serde_json::Value>>,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: WebSearchThreadItemType,
    },
    ImageViewThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        path: LegacyAppPathString,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: ImageViewThreadItemType,
    },
    SleepThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: SleepThreadItemType,
    },
    ImageGenerationThreadItem(ImageGenerationThreadItem),
    EnteredReviewModeThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        review: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: EnteredReviewModeThreadItemType,
    },
    ExitedReviewModeThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        review: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: ExitedReviewModeThreadItemType,
    },
    ContextCompactionThreadItem {
        ///Unix timestamp in milliseconds when the item completed, if recorded.
        #[serde(
            rename = "completedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        completed_at_ms: ::std::option::Option<i64>,
        id: ::std::string::String,
        ///Unix timestamp in milliseconds when the item started, if recorded.
        #[serde(
            rename = "startedAtMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        started_at_ms: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        type_: ContextCompactionThreadItemType,
    },
}
impl ::std::convert::From<ImageGenerationThreadItem> for ThreadItem {
    fn from(value: ImageGenerationThreadItem) -> Self {
        Self::ImageGenerationThreadItem(value)
    }
}
/**There are three ways to resume a thread: 1. By thread_id: load the thread from disk by thread_id and resume it. 2. By history: instantiate the thread from memory and resume it. 3. By path: load the thread from disk by path and resume it.

For non-running threads, the precedence is: history > non-empty path > thread_id. If using history or a non-empty path for a non-running thread, the thread_id param will be ignored.

If thread_id identifies a running thread, app-server rejoins that thread and treats a non-empty path as a consistency check against the active rollout path. Empty string path values are treated as absent.

Prefer using thread_id whenever possible.*/
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ThreadResumeParams {
    #[serde(
        rename = "approvalPolicy",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approval_policy: ::std::option::Option<AskForApproval>,
    ///Override where approval requests are routed for review on this thread and subsequent turns.
    #[serde(
        rename = "approvalsReviewer",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approvals_reviewer: ::std::option::Option<ApprovalsReviewer>,
    #[serde(
        rename = "baseInstructions",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub base_instructions: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub config: ::std::option::Option<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    >,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub cwd: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "developerInstructions",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub developer_instructions: ::std::option::Option<::std::string::String>,
    ///When true, return only thread metadata and live-resume state without populating `thread.turns`. This is useful when the client plans to call `thread/turns/list` immediately after resuming. Full-history hydration is deprecated for paginated threads; use this with `thread/turns/list` and `thread/items/list` instead.
    #[serde(
        rename = "excludeTurns",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub exclude_turns: ::std::option::Option<bool>,
    ///Configuration overrides for the resumed thread, if any.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub model: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "modelProvider",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub model_provider: ::std::option::Option<::std::string::String>,
    ///@deprecated `friendly` and `pragmatic` no longer select a style. Changing this does not rewrite the thread's existing instructions.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub personality: ::std::option::Option<Personality>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub sandbox: ::std::option::Option<SandboxMode>,
    #[serde(
        rename = "serviceTier",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_tier: ::std::option::Option<::std::string::String>,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
}
///`ThreadResumeResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ThreadResumeResponse {
    #[serde(rename = "approvalPolicy")]
    pub approval_policy: AskForApproval,
    ///Reviewer currently used for approval requests on this thread.
    #[serde(rename = "approvalsReviewer")]
    pub approvals_reviewer: ApprovalsReviewer,
    ///Effective collaboration mode. Absent when resuming from an older server.
    #[serde(
        rename = "collaborationMode",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub collaboration_mode: ::std::option::Option<CollaborationMode>,
    pub cwd: AbsolutePathBuf,
    ///Saved list of disabled plugin IDs. Does not yet filter plugin capabilities.
    #[serde(
        rename = "disabledPluginIds",
        default,
        skip_serializing_if = "::std::vec::Vec::is_empty"
    )]
    pub disabled_plugin_ids: ::std::vec::Vec<::std::string::String>,
    ///Environment-native paths to instruction source files currently loaded for this thread.
    #[serde(
        rename = "instructionSources",
        default,
        skip_serializing_if = "::std::vec::Vec::is_empty"
    )]
    pub instruction_sources: ::std::vec::Vec<LegacyAppPathString>,
    /**Opaque cursor for hydrating paginated items backwards.

Pass this as `cursor` to `thread/items/list` with `sortDirection: "desc"`. The first page includes the item identified by the cursor.*/
    #[serde(
        rename = "itemsBackwardsCursor",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub items_backwards_cursor: ::std::option::Option<::std::string::String>,
    pub model: ::std::string::String,
    #[serde(rename = "modelProvider")]
    pub model_provider: ::std::string::String,
    #[serde(
        rename = "reasoningEffort",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub reasoning_effort: ::std::option::Option<ReasoningEffort>,
    ///Legacy sandbox policy retained for compatibility. Experimental clients should prefer `activePermissionProfile` for profile provenance.
    pub sandbox: SandboxPolicy,
    #[serde(
        rename = "serviceTier",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_tier: ::std::option::Option<::std::string::String>,
    pub thread: Thread,
    /**Opaque cursor for hydrating paginated turns backwards.

Pass this as `cursor` to `thread/turns/list` with `sortDirection: "desc"`. The first page includes the turn identified by the cursor.*/
    #[serde(
        rename = "turnsBackwardsCursor",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub turns_backwards_cursor: ::std::option::Option<::std::string::String>,
}
///An independently persisted, user-visible thread section.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ThreadSection {
    ///Optional appearance synchronized across clients.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub appearance: ::std::option::Option<ThreadSectionAppearance>,
    ///Opaque UUIDv7 identity that remains stable when the section is renamed.
    pub id: ::std::string::String,
    ///The current user-visible section name.
    pub name: ::std::string::String,
}
///Extensible visual presentation for a custom thread section.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct ThreadSectionAppearance {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub color: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub icon: ::std::option::Option<::std::string::String>,
}
///`ThreadSetNameParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ThreadSetNameParams {
    pub name: ::std::string::String,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
}
///`ThreadSource`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
#[serde(transparent)]
pub struct ThreadSource(pub ::std::string::String);
impl ::std::ops::Deref for ThreadSource {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<ThreadSource> for ::std::string::String {
    fn from(value: ThreadSource) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::string::String> for ThreadSource {
    fn from(value: ::std::string::String) -> Self {
        Self(value)
    }
}
impl ::std::fmt::Display for ThreadSource {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
impl ::std::str::FromStr for ThreadSource {
    type Err = ::std::convert::Infallible;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.to_string()))
    }
}
///`ThreadStartParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
pub struct ThreadStartParams {
    #[serde(
        rename = "approvalPolicy",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approval_policy: ::std::option::Option<AskForApproval>,
    ///Override where approval requests are routed for review on this thread and subsequent turns.
    #[serde(
        rename = "approvalsReviewer",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approvals_reviewer: ::std::option::Option<ApprovalsReviewer>,
    #[serde(
        rename = "baseInstructions",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub base_instructions: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub config: ::std::option::Option<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    >,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub cwd: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "developerInstructions",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub developer_instructions: ::std::option::Option<::std::string::String>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub ephemeral: ::std::option::Option<bool>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub model: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "modelProvider",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub model_provider: ::std::option::Option<::std::string::String>,
    ///@deprecated `friendly` and `pragmatic` no longer select a style.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub personality: ::std::option::Option<Personality>,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub sandbox: ::std::option::Option<SandboxMode>,
    #[serde(
        rename = "serviceName",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_name: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "serviceTier",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_tier: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "sessionStartSource",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub session_start_source: ::std::option::Option<ThreadStartSource>,
    ///Optional client-supplied analytics source classification for this thread.
    #[serde(
        rename = "threadSource",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub thread_source: ::std::option::Option<ThreadSource>,
}
///`ThreadStartResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ThreadStartResponse {
    #[serde(rename = "approvalPolicy")]
    pub approval_policy: AskForApproval,
    ///Reviewer currently used for approval requests on this thread.
    #[serde(rename = "approvalsReviewer")]
    pub approvals_reviewer: ApprovalsReviewer,
    pub cwd: AbsolutePathBuf,
    ///Saved list of disabled plugin IDs. Does not yet filter plugin capabilities.
    #[serde(
        rename = "disabledPluginIds",
        default,
        skip_serializing_if = "::std::vec::Vec::is_empty"
    )]
    pub disabled_plugin_ids: ::std::vec::Vec<::std::string::String>,
    ///Environment-native paths to instruction source files currently loaded for this thread.
    #[serde(
        rename = "instructionSources",
        default,
        skip_serializing_if = "::std::vec::Vec::is_empty"
    )]
    pub instruction_sources: ::std::vec::Vec<LegacyAppPathString>,
    pub model: ::std::string::String,
    #[serde(rename = "modelProvider")]
    pub model_provider: ::std::string::String,
    #[serde(
        rename = "reasoningEffort",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub reasoning_effort: ::std::option::Option<ReasoningEffort>,
    ///Legacy sandbox policy retained for compatibility. Experimental clients should prefer `activePermissionProfile` for profile provenance.
    pub sandbox: SandboxPolicy,
    #[serde(
        rename = "serviceTier",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_tier: ::std::option::Option<::std::string::String>,
    pub thread: Thread,
}
///`ThreadStartSource`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ThreadStartSource {
    #[serde(rename = "startup")]
    Startup,
    #[serde(rename = "clear")]
    Clear,
}
impl ::std::fmt::Display for ThreadStartSource {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Startup => f.write_str("startup"),
            Self::Clear => f.write_str("clear"),
        }
    }
}
impl ::std::str::FromStr for ThreadStartSource {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "startup" => Ok(Self::Startup),
            "clear" => Ok(Self::Clear),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ThreadStartSource {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ThreadStartSource {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ThreadStatus`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type", content = "activeFlags")]
pub enum ThreadStatus {
    #[serde(rename = "notLoaded")]
    NotLoaded,
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "systemError")]
    SystemError,
    ///ActiveThreadStatus
    #[serde(rename = "active")]
    Active(::std::vec::Vec<ThreadActiveFlag>),
}
impl ::std::convert::From<::std::vec::Vec<ThreadActiveFlag>> for ThreadStatus {
    fn from(value: ::std::vec::Vec<ThreadActiveFlag>) -> Self {
        Self::Active(value)
    }
}
///`Turn`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Turn {
    ///Unix timestamp (in seconds) when the turn completed.
    #[serde(
        rename = "completedAt",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub completed_at: ::std::option::Option<i64>,
    ///Duration between turn start and completion in milliseconds, if known.
    #[serde(
        rename = "durationMs",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub duration_ms: ::std::option::Option<i64>,
    ///Error associated with a failed or interrupted turn.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub error: ::std::option::Option<TurnError>,
    ///Identifier for this turn. Codex-generated turn IDs are UUIDv7.
    pub id: ::std::string::String,
    ///Thread items currently included in this turn payload.
    pub items: ::std::vec::Vec<ThreadItem>,
    ///Describes how much of `items` has been loaded for this turn.
    #[serde(rename = "itemsView", default = "defaults::turn_items_view")]
    pub items_view: TurnItemsView,
    ///ID of the first turn in the chain of work that led to this turn. Pass this as `rootTurnId` when starting work on behalf of this turn. May be null in older history or a `review/start` response.
    #[serde(
        rename = "rootTurnId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub root_turn_id: ::std::option::Option<::std::string::String>,
    ///Unix timestamp (in seconds) when the turn started.
    #[serde(
        rename = "startedAt",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub started_at: ::std::option::Option<i64>,
    pub status: TurnStatus,
}
///`TurnCompletedNotification`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnCompletedNotification {
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    pub turn: Turn,
}
///`TurnError`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnError {
    #[serde(
        rename = "additionalDetails",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub additional_details: ::std::option::Option<::std::string::String>,
    #[serde(
        rename = "codexErrorInfo",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub codex_error_info: ::std::option::Option<CodexErrorInfo>,
    pub message: ::std::string::String,
    ///Optional public explanation and continuation instruction for a misalignment block.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub misalignment: ::std::option::Option<MisalignmentErrorDetails>,
}
///`TurnInterruptParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnInterruptParams {
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(rename = "turnId")]
    pub turn_id: ::std::string::String,
}
///`TurnItemsView`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum TurnItemsView {
    ///`items` was not loaded for this turn. The field is intentionally empty.
    #[serde(rename = "notLoaded")]
    NotLoaded,
    ///`items` contains only a display summary for this turn.
    #[serde(rename = "summary")]
    Summary,
    ///`items` contains every ThreadItem available from persisted app-server history for this turn.
    #[serde(rename = "full")]
    Full,
}
impl ::std::fmt::Display for TurnItemsView {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::NotLoaded => f.write_str("notLoaded"),
            Self::Summary => f.write_str("summary"),
            Self::Full => f.write_str("full"),
        }
    }
}
impl ::std::str::FromStr for TurnItemsView {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "notLoaded" => Ok(Self::NotLoaded),
            "summary" => Ok(Self::Summary),
            "full" => Ok(Self::Full),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for TurnItemsView {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for TurnItemsView {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`TurnStartParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnStartParams {
    ///Override the approval policy for this turn and subsequent turns.
    #[serde(
        rename = "approvalPolicy",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approval_policy: ::std::option::Option<AskForApproval>,
    ///Override where approval requests are routed for review on this turn and subsequent turns.
    #[serde(
        rename = "approvalsReviewer",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub approvals_reviewer: ::std::option::Option<ApprovalsReviewer>,
    #[serde(
        rename = "clientUserMessageId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub client_user_message_id: ::std::option::Option<::std::string::String>,
    ///Override the working directory for this turn and subsequent turns.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub cwd: ::std::option::Option<::std::string::String>,
    ///Replace this thread's disabled plugin IDs. Omitted/null preserves the list; [] clears it.
    #[serde(
        rename = "disabledPluginIds",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub disabled_plugin_ids: ::std::option::Option<
        ::std::vec::Vec<::std::string::String>,
    >,
    ///Override the reasoning effort for this turn and subsequent turns.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub effort: ::std::option::Option<ReasoningEffort>,
    pub input: ::std::vec::Vec<UserInput>,
    ///Override the model for this turn and subsequent turns.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub model: ::std::option::Option<::std::string::String>,
    ///Optional JSON Schema used to constrain the final assistant message for this turn.
    #[serde(
        rename = "outputSchema",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub output_schema: ::std::option::Option<::serde_json::Value>,
    /**ID of the turn that caused this new turn to start.

Set this when starting work on behalf of another turn, such as delegated work in a different thread. Leave unset for work started directly by the user. Ignored when this request adds input to an active turn.*/
    #[serde(
        rename = "parentTurnId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub parent_turn_id: ::std::option::Option<::std::string::String>,
    ///@deprecated `friendly` and `pragmatic` no longer select a style. Changing this does not rewrite the thread's existing instructions.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub personality: ::std::option::Option<Personality>,
    /**ID of the first turn in the chain of work that led to this new turn.

When setting `parentTurnId`, set this to the parent turn's `rootTurnId` when known. This keeps descendant work attributed to the original turn. If omitted, the new turn becomes its own root. Ignored when this request adds input to an active turn.*/
    #[serde(
        rename = "rootTurnId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub root_turn_id: ::std::option::Option<::std::string::String>,
    ///Override the sandbox policy for this turn and subsequent turns.
    #[serde(
        rename = "sandboxPolicy",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub sandbox_policy: ::std::option::Option<SandboxPolicy>,
    ///Override the service tier for this turn and subsequent turns.
    #[serde(
        rename = "serviceTier",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_tier: ::std::option::Option<::std::string::String>,
    ///Override the service tier only when this request starts a new turn. Use "default" for standard speed. Omitted or null inherits the thread's tier. Does not change the thread's tier or a turn being steered.
    #[serde(
        rename = "serviceTierForTurn",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub service_tier_for_turn: ::std::option::Option<::std::string::String>,
    ///Override the reasoning summary for this turn and subsequent turns.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub summary: ::std::option::Option<ReasoningSummary>,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
    #[serde(
        rename = "toolOutput",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub tool_output: ::std::option::Option<TurnToolOutput>,
    ///Optional source classification for the caller that starts this turn. Ignored when this request steers an already-active turn.
    #[serde(
        rename = "turnTrigger",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub turn_trigger: ::std::option::Option<::std::string::String>,
}
///`TurnStartResponse`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnStartResponse {
    pub turn: Turn,
}
///`TurnStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum TurnStatus {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "inProgress")]
    InProgress,
}
impl ::std::fmt::Display for TurnStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Completed => f.write_str("completed"),
            Self::Interrupted => f.write_str("interrupted"),
            Self::Failed => f.write_str("failed"),
            Self::InProgress => f.write_str("inProgress"),
        }
    }
}
impl ::std::str::FromStr for TurnStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "completed" => Ok(Self::Completed),
            "interrupted" => Ok(Self::Interrupted),
            "failed" => Ok(Self::Failed),
            "inProgress" => Ok(Self::InProgress),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for TurnStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for TurnStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`TurnSteerParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnSteerParams {
    #[serde(
        rename = "clientUserMessageId",
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub client_user_message_id: ::std::option::Option<::std::string::String>,
    ///Required active turn id precondition. The request fails when it does not match the currently active turn.
    #[serde(rename = "expectedTurnId")]
    pub expected_turn_id: ::std::string::String,
    pub input: ::std::vec::Vec<UserInput>,
    #[serde(rename = "threadId")]
    pub thread_id: ::std::string::String,
}
///`TurnToolOutput`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TurnToolOutput {
    pub name: ::std::string::String,
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub namespace: ::std::option::Option<::std::string::String>,
    pub output: FunctionCallOutputBody,
    ///Requests retention of this output in the thread's model history.
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub retain: ::std::option::Option<bool>,
}
///`UserInput`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum UserInput {
    TextUserInput {
        text: ::std::string::String,
        ///UI-defined spans within `text` used to render or persist special elements.
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        text_elements: ::std::vec::Vec<TextElement>,
        #[serde(rename = "type")]
        type_: TextUserInputType,
    },
    ImageUserInput(ImageUserInput),
    LocalImageUserInput {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        detail: ::std::option::Option<ImageDetail>,
        path: ::std::string::String,
        #[serde(rename = "type")]
        type_: LocalImageUserInputType,
    },
    AudioUserInput(AudioUserInput),
    LocalAudioUserInput {
        path: ::std::string::String,
        #[serde(rename = "type")]
        type_: LocalAudioUserInputType,
    },
    SkillUserInput {
        name: ::std::string::String,
        path: ::std::string::String,
        #[serde(rename = "type")]
        type_: SkillUserInputType,
    },
    MentionUserInput {
        name: ::std::string::String,
        path: ::std::string::String,
        #[serde(rename = "type")]
        type_: MentionUserInputType,
    },
}
impl ::std::convert::From<ImageUserInput> for UserInput {
    fn from(value: ImageUserInput) -> Self {
        Self::ImageUserInput(value)
    }
}
impl ::std::convert::From<AudioUserInput> for UserInput {
    fn from(value: AudioUserInput) -> Self {
        Self::AudioUserInput(value)
    }
}
///`UserMessageThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum UserMessageThreadItemType {
    #[serde(rename = "userMessage")]
    UserMessage,
}
impl ::std::fmt::Display for UserMessageThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::UserMessage => f.write_str("userMessage"),
        }
    }
}
impl ::std::str::FromStr for UserMessageThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "userMessage" => Ok(Self::UserMessage),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for UserMessageThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for UserMessageThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`WebSearchAction`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum WebSearchAction {
    ///SearchWebSearchAction
    #[serde(rename = "search")]
    Search {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        queries: ::std::option::Option<::std::vec::Vec<::std::string::String>>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        query: ::std::option::Option<::std::string::String>,
    },
    ///OpenPageWebSearchAction
    #[serde(rename = "openPage")]
    OpenPage {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        url: ::std::option::Option<::std::string::String>,
    },
    ///FindInPageWebSearchAction
    #[serde(rename = "findInPage")]
    FindInPage {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pattern: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        url: ::std::option::Option<::std::string::String>,
    },
    #[serde(rename = "other")]
    Other,
}
///`WebSearchThreadItemType`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum WebSearchThreadItemType {
    #[serde(rename = "webSearch")]
    WebSearch,
}
impl ::std::fmt::Display for WebSearchThreadItemType {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::WebSearch => f.write_str("webSearch"),
        }
    }
}
impl ::std::str::FromStr for WebSearchThreadItemType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "webSearch" => Ok(Self::WebSearch),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for WebSearchThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for WebSearchThreadItemType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
/// Generation of default values for serde.
pub mod defaults {
    pub(super) fn command_execution_request_approval_params_kind() -> super::CommandExecutionApprovalKind {
        super::CommandExecutionApprovalKind::Command
    }
    pub(super) fn model_input_modalities() -> ::std::vec::Vec<super::InputModality> {
        vec![super::InputModality::Text, super::InputModality::Image]
    }
    pub(super) fn sandbox_policy_external_sandbox_network_access() -> super::NetworkAccess {
        super::NetworkAccess::Restricted
    }
    pub(super) fn thread_history_mode() -> super::ThreadHistoryMode {
        super::ThreadHistoryMode::Legacy
    }
    pub(super) fn thread_item_command_execution_thread_item_source() -> super::CommandExecutionSource {
        super::CommandExecutionSource::Agent
    }
    pub(super) fn turn_items_view() -> super::TurnItemsView {
        super::TurnItemsView::Full
    }
}
/// Error types.
pub mod error {
    /// Error from a `TryFrom` or `FromStr` implementation.
    pub struct ConversionError(::std::borrow::Cow<'static, str>);
    impl ::std::error::Error for ConversionError {}
    impl ::std::fmt::Display for ConversionError {
        fn fmt(
            &self,
            f: &mut ::std::fmt::Formatter<'_>,
        ) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Display::fmt(&self.0, f)
        }
    }
    impl ::std::fmt::Debug for ConversionError {
        fn fmt(
            &self,
            f: &mut ::std::fmt::Formatter<'_>,
        ) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Debug::fmt(&self.0, f)
        }
    }
    impl From<&'static str> for ConversionError {
        fn from(value: &'static str) -> Self {
            Self(value.into())
        }
    }
    impl From<String> for ConversionError {
        fn from(value: String) -> Self {
            Self(value.into())
        }
    }
}
