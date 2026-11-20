// @generated par `cargo run --manifest-path src-tauri/codegen/Cargo.toml` depuis
// `src-tauri/schemas/opencode/openapi.json` : ne pas éditer à la main.
#![allow(clippy::all, clippy::pedantic, dead_code, unused_imports, irrefutable_let_patterns, unreachable_pub)]
#[allow(unused_imports)]
pub use progenitor_client::{ByteStream, ClientInfo, Error, ResponseValue};
#[allow(unused_imports)]
use progenitor_client::{
    encode_path, ClientHooks, OperationInfo, QueryParam, RequestBuilderExt,
};
/// Types used as operation parameters and responses.
#[allow(clippy::all)]
pub mod types {
    ///`AbsolutePath`
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
    pub struct AbsolutePath(pub ::std::string::String);
    impl ::std::ops::Deref for AbsolutePath {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<AbsolutePath> for ::std::string::String {
        fn from(value: AbsolutePath) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for AbsolutePath {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for AbsolutePath {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for AbsolutePath {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`AgentId`
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
    pub struct AgentId(pub ::std::string::String);
    impl ::std::ops::Deref for AgentId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<AgentId> for ::std::string::String {
        fn from(value: AgentId) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for AgentId {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for AgentId {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for AgentId {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`ConflictErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ConflictErrorEncoded {
        pub message: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub resource: ::std::option::Option<::std::string::String>,
        #[serde(rename = "_tag")]
        pub tag: ConflictErrorEncodedTag,
    }
    ///`ConflictErrorEncodedTag`
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
    pub enum ConflictErrorEncodedTag {
        ConflictError,
    }
    impl ::std::fmt::Display for ConflictErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::ConflictError => f.write_str("ConflictError"),
            }
        }
    }
    impl ::std::str::FromStr for ConflictErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "ConflictError" => Ok(Self::ConflictError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ConflictErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ConflictErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ExperimentalSessionInstructionsEntryPutBody`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ExperimentalSessionInstructionsEntryPutBody {
        pub value: ::serde_json::Value,
    }
    ///`FileDiffInfo`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct FileDiffInfo {
        pub additions: u64,
        pub deletions: u64,
        pub file: ::std::string::String,
        pub patch: ::std::string::String,
        pub status: FileDiffInfoStatus,
    }
    ///`FileDiffInfoStatus`
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
    pub enum FileDiffInfoStatus {
        #[serde(rename = "added")]
        Added,
        #[serde(rename = "deleted")]
        Deleted,
        #[serde(rename = "modified")]
        Modified,
    }
    impl ::std::fmt::Display for FileDiffInfoStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Added => f.write_str("added"),
                Self::Deleted => f.write_str("deleted"),
                Self::Modified => f.write_str("modified"),
            }
        }
    }
    impl ::std::str::FromStr for FileDiffInfoStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "added" => Ok(Self::Added),
                "deleted" => Ok(Self::Deleted),
                "modified" => Ok(Self::Modified),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for FileDiffInfoStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for FileDiffInfoStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///Instruction entry key (lowercase alphanumerics plus . _ -)
    #[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    #[serde(transparent)]
    pub struct InstructionEntryKey(::std::string::String);
    impl ::std::ops::Deref for InstructionEntryKey {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<InstructionEntryKey> for ::std::string::String {
        fn from(value: InstructionEntryKey) -> Self {
            value.0
        }
    }
    impl ::std::str::FromStr for InstructionEntryKey {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
            { ::regress::Regex::new("^[a-z0-9][a-z0-9._-]*$").unwrap() });
            if PATTERN.find(value).is_none() {
                return Err("doesn't match pattern \"^[a-z0-9][a-z0-9._-]*$\"".into());
            }
            Ok(Self(value.to_string()))
        }
    }
    impl ::std::convert::TryFrom<&str> for InstructionEntryKey {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for InstructionEntryKey {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl<'de> ::serde::Deserialize<'de> for InstructionEntryKey {
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
    ///`InstructionEntryValueTooLargeErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct InstructionEntryValueTooLargeErrorEncoded {
        #[serde(rename = "actualBytes")]
        pub actual_bytes: i64,
        #[serde(rename = "maxBytes")]
        pub max_bytes: i64,
        pub message: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: InstructionEntryValueTooLargeErrorEncodedTag,
    }
    ///`InstructionEntryValueTooLargeErrorEncodedTag`
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
    pub enum InstructionEntryValueTooLargeErrorEncodedTag {
        InstructionEntryValueTooLargeError,
    }
    impl ::std::fmt::Display for InstructionEntryValueTooLargeErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::InstructionEntryValueTooLargeError => {
                    f.write_str("InstructionEntryValueTooLargeError")
                }
            }
        }
    }
    impl ::std::str::FromStr for InstructionEntryValueTooLargeErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "InstructionEntryValueTooLargeError" => {
                    Ok(Self::InstructionEntryValueTooLargeError)
                }
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for InstructionEntryValueTooLargeErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for InstructionEntryValueTooLargeErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`InvalidCursorErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct InvalidCursorErrorEncoded {
        pub message: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: InvalidCursorErrorEncodedTag,
    }
    ///`InvalidCursorErrorEncodedTag`
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
    pub enum InvalidCursorErrorEncodedTag {
        InvalidCursorError,
    }
    impl ::std::fmt::Display for InvalidCursorErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::InvalidCursorError => f.write_str("InvalidCursorError"),
            }
        }
    }
    impl ::std::str::FromStr for InvalidCursorErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "InvalidCursorError" => Ok(Self::InvalidCursorError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for InvalidCursorErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for InvalidCursorErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`InvalidRequestErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct InvalidRequestErrorEncoded {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub field: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub kind: ::std::option::Option<::std::string::String>,
        pub message: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: InvalidRequestErrorEncodedTag,
    }
    ///`InvalidRequestErrorEncodedTag`
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
    pub enum InvalidRequestErrorEncodedTag {
        InvalidRequestError,
    }
    impl ::std::fmt::Display for InvalidRequestErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::InvalidRequestError => f.write_str("InvalidRequestError"),
            }
        }
    }
    impl ::std::str::FromStr for InvalidRequestErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "InvalidRequestError" => Ok(Self::InvalidRequestError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for InvalidRequestErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for InvalidRequestErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`LocationNotFoundErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct LocationNotFoundErrorEncoded {
        pub location: LocationPublicRef,
        pub message: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: LocationNotFoundErrorEncodedTag,
    }
    ///`LocationNotFoundErrorEncodedTag`
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
    pub enum LocationNotFoundErrorEncodedTag {
        LocationNotFoundError,
    }
    impl ::std::fmt::Display for LocationNotFoundErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::LocationNotFoundError => f.write_str("LocationNotFoundError"),
            }
        }
    }
    impl ::std::str::FromStr for LocationNotFoundErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "LocationNotFoundError" => Ok(Self::LocationNotFoundError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for LocationNotFoundErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for LocationNotFoundErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`LocationPublicRef`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct LocationPublicRef {
        pub directory: AbsolutePath,
    }
    ///`ModelCacheFormat`
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
    pub enum ModelCacheFormat {
        #[serde(rename = "anthropic")]
        Anthropic,
        #[serde(rename = "alibaba")]
        Alibaba,
    }
    impl ::std::fmt::Display for ModelCacheFormat {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Anthropic => f.write_str("anthropic"),
                Self::Alibaba => f.write_str("alibaba"),
            }
        }
    }
    impl ::std::str::FromStr for ModelCacheFormat {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "anthropic" => Ok(Self::Anthropic),
                "alibaba" => Ok(Self::Alibaba),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ModelCacheFormat {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ModelCacheFormat {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ModelCapabilities`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelCapabilities {
        pub input: ::std::vec::Vec<::std::string::String>,
        pub output: ::std::vec::Vec<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub temperature: ::std::option::Option<bool>,
        pub tools: bool,
    }
    ///`ModelCompatibility`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
    #[serde(deny_unknown_fields)]
    pub struct ModelCompatibility {
        #[serde(
            rename = "cacheFormat",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub cache_format: ::std::option::Option<ModelCacheFormat>,
        #[serde(
            rename = "maxTokensField",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub max_tokens_field: ::std::option::Option<ModelMaxTokensField>,
        #[serde(
            rename = "reasoningField",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub reasoning_field: ::std::option::Option<ModelReasoningField>,
        #[serde(
            rename = "requireAssistantAfterTool",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub require_assistant_after_tool: ::std::option::Option<bool>,
        #[serde(
            rename = "requireFinishReason",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub require_finish_reason: ::std::option::Option<bool>,
        #[serde(
            rename = "requireReasoning",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub require_reasoning: ::std::option::Option<bool>,
        #[serde(
            rename = "streamUsage",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub stream_usage: ::std::option::Option<bool>,
        #[serde(
            rename = "supportsEffortUpdates",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub supports_effort_updates: ::std::option::Option<bool>,
        #[serde(
            rename = "supportsPromptCacheKey",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub supports_prompt_cache_key: ::std::option::Option<bool>,
        #[serde(
            rename = "supportsThinkingBlockBinding",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub supports_thinking_block_binding: ::std::option::Option<bool>,
    }
    ///`ModelCost`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelCost {
        pub cache: ModelCostCache,
        pub input: MoneyUsdPerMillionTokens,
        pub output: MoneyUsdPerMillionTokens,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub tier: ::std::option::Option<ModelCostTier>,
    }
    ///`ModelCostCache`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelCostCache {
        pub read: MoneyUsdPerMillionTokens,
        pub write: MoneyUsdPerMillionTokens,
    }
    ///`ModelCostTier`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelCostTier {
        pub size: i64,
        #[serde(rename = "type")]
        pub type_: ModelCostTierType,
    }
    ///`ModelCostTierType`
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
    pub enum ModelCostTierType {
        #[serde(rename = "context")]
        Context,
    }
    impl ::std::fmt::Display for ModelCostTierType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Context => f.write_str("context"),
            }
        }
    }
    impl ::std::str::FromStr for ModelCostTierType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "context" => Ok(Self::Context),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ModelCostTierType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ModelCostTierType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ModelInfo`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelInfo {
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub body: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub canonical: ::std::option::Option<ProviderId>,
        pub capabilities: ModelCapabilities,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub compatibility: ::std::option::Option<ModelCompatibility>,
        pub cost: ::std::vec::Vec<ModelCost>,
        pub enabled: bool,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub family: ::std::option::Option<::std::string::String>,
        #[serde(
            default,
            skip_serializing_if = ":: std :: collections :: HashMap::is_empty"
        )]
        pub headers: ::std::collections::HashMap<
            ::std::string::String,
            ::std::string::String,
        >,
        pub id: ::std::string::String,
        pub limit: ModelInfoLimit,
        #[serde(rename = "modelID")]
        pub model_id: ::std::string::String,
        pub name: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub package: ::std::option::Option<::std::string::String>,
        #[serde(rename = "providerID")]
        pub provider_id: ProviderId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub settings: ::std::option::Option<ModelSettings>,
        pub status: ModelInfoStatus,
        pub time: ModelInfoTime,
        pub variants: ::std::vec::Vec<ModelVariant>,
    }
    ///`ModelInfoLimit`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelInfoLimit {
        pub context: i64,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub input: ::std::option::Option<i64>,
        pub output: i64,
    }
    ///`ModelInfoStatus`
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
    pub enum ModelInfoStatus {
        #[serde(rename = "alpha")]
        Alpha,
        #[serde(rename = "beta")]
        Beta,
        #[serde(rename = "deprecated")]
        Deprecated,
        #[serde(rename = "active")]
        Active,
    }
    impl ::std::fmt::Display for ModelInfoStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Alpha => f.write_str("alpha"),
                Self::Beta => f.write_str("beta"),
                Self::Deprecated => f.write_str("deprecated"),
                Self::Active => f.write_str("active"),
            }
        }
    }
    impl ::std::str::FromStr for ModelInfoStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "alpha" => Ok(Self::Alpha),
                "beta" => Ok(Self::Beta),
                "deprecated" => Ok(Self::Deprecated),
                "active" => Ok(Self::Active),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ModelInfoStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ModelInfoStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ModelInfoTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelInfoTime {
        pub released: f64,
    }
    ///`ModelListResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelListResponse {
        pub data: ::std::vec::Vec<ModelInfo>,
        pub location: LocationPublicRef,
    }
    ///`ModelMaxTokensField`
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
    pub enum ModelMaxTokensField {
        #[serde(rename = "max_completion_tokens")]
        MaxCompletionTokens,
        #[serde(rename = "max_tokens")]
        MaxTokens,
    }
    impl ::std::fmt::Display for ModelMaxTokensField {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::MaxCompletionTokens => f.write_str("max_completion_tokens"),
                Self::MaxTokens => f.write_str("max_tokens"),
            }
        }
    }
    impl ::std::str::FromStr for ModelMaxTokensField {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "max_completion_tokens" => Ok(Self::MaxCompletionTokens),
                "max_tokens" => Ok(Self::MaxTokens),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ModelMaxTokensField {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ModelMaxTokensField {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ModelReasoningField`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum ModelReasoningField {
        Variant0(ModelReasoningFieldVariant0),
        Variant1(::std::string::String),
    }
    impl ::std::convert::From<ModelReasoningFieldVariant0> for ModelReasoningField {
        fn from(value: ModelReasoningFieldVariant0) -> Self {
            Self::Variant0(value)
        }
    }
    ///`ModelReasoningFieldVariant0`
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
    pub enum ModelReasoningFieldVariant0 {
        #[serde(rename = "reasoning")]
        Reasoning,
        #[serde(rename = "reasoning_content")]
        ReasoningContent,
        #[serde(rename = "reasoning_text")]
        ReasoningText,
    }
    impl ::std::fmt::Display for ModelReasoningFieldVariant0 {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Reasoning => f.write_str("reasoning"),
                Self::ReasoningContent => f.write_str("reasoning_content"),
                Self::ReasoningText => f.write_str("reasoning_text"),
            }
        }
    }
    impl ::std::str::FromStr for ModelReasoningFieldVariant0 {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "reasoning" => Ok(Self::Reasoning),
                "reasoning_content" => Ok(Self::ReasoningContent),
                "reasoning_text" => Ok(Self::ReasoningText),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ModelReasoningFieldVariant0 {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ModelReasoningFieldVariant0 {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ModelRef`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelRef {
        pub id: ::std::string::String,
        #[serde(rename = "providerID")]
        pub provider_id: ProviderId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub variant: ::std::option::Option<::std::string::String>,
    }
    ///`ModelSettings`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    pub struct ModelSettings {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub compaction: ::std::option::Option<ProviderCompaction>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub encoding: ::std::option::Option<ProviderEncoding>,
        #[serde(flatten)]
        pub extra: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    }
    ///`ModelVariant`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ModelVariant {
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub body: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(
            default,
            skip_serializing_if = ":: std :: collections :: HashMap::is_empty"
        )]
        pub headers: ::std::collections::HashMap<
            ::std::string::String,
            ::std::string::String,
        >,
        pub id: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub settings: ::std::option::Option<ModelSettings>,
    }
    ///`MoneyUsd`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct MoneyUsd(pub f64);
    impl ::std::ops::Deref for MoneyUsd {
        type Target = f64;
        fn deref(&self) -> &f64 {
            &self.0
        }
    }
    impl ::std::convert::From<MoneyUsd> for f64 {
        fn from(value: MoneyUsd) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<f64> for MoneyUsd {
        fn from(value: f64) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for MoneyUsd {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for MoneyUsd {
        type Err = <f64 as ::std::str::FromStr>::Err;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.parse()?))
        }
    }
    impl ::std::convert::TryFrom<&str> for MoneyUsd {
        type Error = <f64 as ::std::str::FromStr>::Err;
        fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<String> for MoneyUsd {
        type Error = <f64 as ::std::str::FromStr>::Err;
        fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
            value.parse()
        }
    }
    ///`MoneyUsdPerMillionTokens`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct MoneyUsdPerMillionTokens(pub f64);
    impl ::std::ops::Deref for MoneyUsdPerMillionTokens {
        type Target = f64;
        fn deref(&self) -> &f64 {
            &self.0
        }
    }
    impl ::std::convert::From<MoneyUsdPerMillionTokens> for f64 {
        fn from(value: MoneyUsdPerMillionTokens) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<f64> for MoneyUsdPerMillionTokens {
        fn from(value: f64) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for MoneyUsdPerMillionTokens {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for MoneyUsdPerMillionTokens {
        type Err = <f64 as ::std::str::FromStr>::Err;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.parse()?))
        }
    }
    impl ::std::convert::TryFrom<&str> for MoneyUsdPerMillionTokens {
        type Error = <f64 as ::std::str::FromStr>::Err;
        fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<String> for MoneyUsdPerMillionTokens {
        type Error = <f64 as ::std::str::FromStr>::Err;
        fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
            value.parse()
        }
    }
    ///`PairingCode`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PairingCode {
        pub code: ::std::string::String,
        pub expires_in: i64,
    }
    ///`PairingSession`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PairingSession {
        pub token: ::std::string::String,
    }
    ///`PermissionEffect`
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
    pub enum PermissionEffect {
        #[serde(rename = "allow")]
        Allow,
        #[serde(rename = "deny")]
        Deny,
        #[serde(rename = "ask")]
        Ask,
    }
    impl ::std::fmt::Display for PermissionEffect {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Allow => f.write_str("allow"),
                Self::Deny => f.write_str("deny"),
                Self::Ask => f.write_str("ask"),
            }
        }
    }
    impl ::std::str::FromStr for PermissionEffect {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "allow" => Ok(Self::Allow),
                "deny" => Ok(Self::Deny),
                "ask" => Ok(Self::Ask),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for PermissionEffect {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for PermissionEffect {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`PermissionId`
    #[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    #[serde(transparent)]
    pub struct PermissionId(::std::string::String);
    impl ::std::ops::Deref for PermissionId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<PermissionId> for ::std::string::String {
        fn from(value: PermissionId) -> Self {
            value.0
        }
    }
    impl ::std::str::FromStr for PermissionId {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
            { ::regress::Regex::new("^per").unwrap() });
            if PATTERN.find(value).is_none() {
                return Err("doesn't match pattern \"^per\"".into());
            }
            Ok(Self(value.to_string()))
        }
    }
    impl ::std::convert::TryFrom<&str> for PermissionId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for PermissionId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl<'de> ::serde::Deserialize<'de> for PermissionId {
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
    ///`PermissionNotFoundErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PermissionNotFoundErrorEncoded {
        pub message: ::std::string::String,
        #[serde(rename = "requestID")]
        pub request_id: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: PermissionNotFoundErrorEncodedTag,
    }
    ///`PermissionNotFoundErrorEncodedTag`
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
    pub enum PermissionNotFoundErrorEncodedTag {
        PermissionNotFoundError,
    }
    impl ::std::fmt::Display for PermissionNotFoundErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::PermissionNotFoundError => f.write_str("PermissionNotFoundError"),
            }
        }
    }
    impl ::std::str::FromStr for PermissionNotFoundErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "PermissionNotFoundError" => Ok(Self::PermissionNotFoundError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for PermissionNotFoundErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for PermissionNotFoundErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`PermissionReply`
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
    pub enum PermissionReply {
        #[serde(rename = "once")]
        Once,
        #[serde(rename = "always")]
        Always,
        #[serde(rename = "reject")]
        Reject,
    }
    impl ::std::fmt::Display for PermissionReply {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Once => f.write_str("once"),
                Self::Always => f.write_str("always"),
                Self::Reject => f.write_str("reject"),
            }
        }
    }
    impl ::std::str::FromStr for PermissionReply {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "once" => Ok(Self::Once),
                "always" => Ok(Self::Always),
                "reject" => Ok(Self::Reject),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for PermissionReply {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for PermissionReply {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`PermissionRequest`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PermissionRequest {
        pub action: ::std::string::String,
        pub id: PermissionId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub message: ::std::option::Option<::std::string::String>,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub resources: ::std::vec::Vec<::std::string::String>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub save: ::std::vec::Vec<::std::string::String>,
        #[serde(rename = "sessionID")]
        pub session_id: SessionId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub source: ::std::option::Option<PermissionSource>,
    }
    ///`PermissionRule`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PermissionRule {
        pub action: ::std::string::String,
        pub effect: PermissionEffect,
        pub resource: ::std::string::String,
    }
    ///`PermissionRuleset`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct PermissionRuleset(pub ::std::vec::Vec<PermissionRule>);
    impl ::std::ops::Deref for PermissionRuleset {
        type Target = ::std::vec::Vec<PermissionRule>;
        fn deref(&self) -> &::std::vec::Vec<PermissionRule> {
            &self.0
        }
    }
    impl ::std::convert::From<PermissionRuleset> for ::std::vec::Vec<PermissionRule> {
        fn from(value: PermissionRuleset) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::vec::Vec<PermissionRule>> for PermissionRuleset {
        fn from(value: ::std::vec::Vec<PermissionRule>) -> Self {
            Self(value)
        }
    }
    ///`PermissionSource`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(tag = "type", deny_unknown_fields)]
    pub enum PermissionSource {
        #[serde(rename = "tool")]
        Tool {
            id: ::std::string::String,
            #[serde(rename = "messageID")]
            message_id: ::std::string::String,
        },
    }
    ///`ProjectId`
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
    pub struct ProjectId(pub ::std::string::String);
    impl ::std::ops::Deref for ProjectId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<ProjectId> for ::std::string::String {
        fn from(value: ProjectId) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for ProjectId {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for ProjectId {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for ProjectId {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`PromptAgentAttachment`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PromptAgentAttachment {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub mention: ::std::option::Option<PromptMention>,
        pub name: ::std::string::String,
    }
    ///`PromptBase64`
    #[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    #[serde(transparent)]
    pub struct PromptBase64(::std::string::String);
    impl ::std::ops::Deref for PromptBase64 {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<PromptBase64> for ::std::string::String {
        fn from(value: PromptBase64) -> Self {
            value.0
        }
    }
    impl ::std::str::FromStr for PromptBase64 {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
            {
                ::regress::Regex::new(
                        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
                    )
                    .unwrap()
            });
            if PATTERN.find(value).is_none() {
                return Err(
                    "doesn't match pattern \"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$\""
                        .into(),
                );
            }
            Ok(Self(value.to_string()))
        }
    }
    impl ::std::convert::TryFrom<&str> for PromptBase64 {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for PromptBase64 {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl<'de> ::serde::Deserialize<'de> for PromptBase64 {
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
    ///`PromptFileAttachment`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PromptFileAttachment {
        pub data: PromptBase64,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub description: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub mention: ::std::option::Option<PromptMention>,
        pub mime: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub name: ::std::option::Option<::std::string::String>,
        pub source: PromptFileSource,
    }
    ///`PromptFileSource`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(tag = "type", content = "uri")]
    pub enum PromptFileSource {
        #[serde(rename = "inline")]
        Inline,
        #[serde(rename = "uri")]
        Uri(::std::string::String),
    }
    ///`PromptInputFileAttachment`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PromptInputFileAttachment {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub description: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub mention: ::std::option::Option<PromptMention>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub name: ::std::option::Option<::std::string::String>,
        pub uri: ::std::string::String,
    }
    ///`PromptInputSkillAttachment`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PromptInputSkillAttachment {
        pub id: SkillId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub mention: ::std::option::Option<PromptMention>,
    }
    ///`PromptMention`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PromptMention {
        pub end: f64,
        pub start: f64,
        pub text: ::std::string::String,
    }
    ///`PromptSkillAttachment`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct PromptSkillAttachment {
        pub id: SkillId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub mention: ::std::option::Option<PromptMention>,
        pub name: SkillName,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub text: ::std::option::Option<::std::string::String>,
    }
    ///`ProviderCompaction`
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
    #[serde(tag = "type", deny_unknown_fields)]
    pub enum ProviderCompaction {
        #[serde(rename = "summary")]
        Summary,
        #[serde(rename = "native")]
        Native,
    }
    impl ::std::fmt::Display for ProviderCompaction {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Summary => f.write_str("summary"),
                Self::Native => f.write_str("native"),
            }
        }
    }
    impl ::std::str::FromStr for ProviderCompaction {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "summary" => Ok(Self::Summary),
                "native" => Ok(Self::Native),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ProviderCompaction {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ProviderCompaction {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ProviderEncoding`
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
    pub enum ProviderEncoding {
        #[serde(rename = "zstd")]
        Zstd,
        #[serde(rename = "gzip")]
        Gzip,
        #[serde(rename = "none")]
        None,
    }
    impl ::std::fmt::Display for ProviderEncoding {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Zstd => f.write_str("zstd"),
                Self::Gzip => f.write_str("gzip"),
                Self::None => f.write_str("none"),
            }
        }
    }
    impl ::std::str::FromStr for ProviderEncoding {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "zstd" => Ok(Self::Zstd),
                "gzip" => Ok(Self::Gzip),
                "none" => Ok(Self::None),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ProviderEncoding {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ProviderEncoding {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ProviderId`
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
    pub struct ProviderId(pub ::std::string::String);
    impl ::std::ops::Deref for ProviderId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<ProviderId> for ::std::string::String {
        fn from(value: ProviderId) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for ProviderId {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for ProviderId {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for ProviderId {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`RelativePath`
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
    pub struct RelativePath(pub ::std::string::String);
    impl ::std::ops::Deref for RelativePath {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<RelativePath> for ::std::string::String {
        fn from(value: RelativePath) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for RelativePath {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for RelativePath {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for RelativePath {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`ServerInfo`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ServerInfo {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub capabilities: ::std::option::Option<ServerInfoCapabilities>,
        pub paths: ServerInfoPaths,
        pub pid: u64,
        pub urls: ::std::vec::Vec<::std::string::String>,
        pub version: ::std::string::String,
    }
    ///`ServerInfoCapabilities`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
    #[serde(deny_unknown_fields)]
    pub struct ServerInfoCapabilities {
        #[serde(
            rename = "persistentPty",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub persistent_pty: ::std::option::Option<bool>,
    }
    ///`ServerInfoPaths`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ServerInfoPaths {
        pub tmp: ::std::string::String,
    }
    ///`ServiceUnavailableErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ServiceUnavailableErrorEncoded {
        pub message: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub service: ::std::option::Option<::std::string::String>,
        #[serde(rename = "_tag")]
        pub tag: ServiceUnavailableErrorEncodedTag,
    }
    ///`ServiceUnavailableErrorEncodedTag`
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
    pub enum ServiceUnavailableErrorEncodedTag {
        ServiceUnavailableError,
    }
    impl ::std::fmt::Display for ServiceUnavailableErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::ServiceUnavailableError => f.write_str("ServiceUnavailableError"),
            }
        }
    }
    impl ::std::str::FromStr for ServiceUnavailableErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "ServiceUnavailableError" => Ok(Self::ServiceUnavailableError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ServiceUnavailableErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for ServiceUnavailableErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionCreateBody`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
    #[serde(deny_unknown_fields)]
    pub struct SessionCreateBody {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub agent: ::std::option::Option<AgentId>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub id: ::std::option::Option<SessionId>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub location: ::std::option::Option<LocationPublicRef>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub metadata: ::std::option::Option<SessionMetadata>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub model: ::std::option::Option<ModelRef>,
        #[serde(
            rename = "parentID",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub parent_id: ::std::option::Option<SessionId>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub permissions: ::std::option::Option<PermissionRuleset>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub title: ::std::option::Option<::std::string::String>,
    }
    ///`SessionCreateResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionCreateResponse {
        pub data: SessionInfo,
    }
    ///`SessionForkBoundary`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(tag = "type", content = "messageID")]
    pub enum SessionForkBoundary {
        #[serde(rename = "before")]
        Before(SessionMessageId),
        #[serde(rename = "through")]
        Through(SessionMessageId),
    }
    ///`SessionGetResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionGetResponse {
        pub data: SessionInfo,
    }
    ///`SessionId`
    #[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    #[serde(transparent)]
    pub struct SessionId(::std::string::String);
    impl ::std::ops::Deref for SessionId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<SessionId> for ::std::string::String {
        fn from(value: SessionId) -> Self {
            value.0
        }
    }
    impl ::std::str::FromStr for SessionId {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
            { ::regress::Regex::new("^ses").unwrap() });
            if PATTERN.find(value).is_none() {
                return Err("doesn't match pattern \"^ses\"".into());
            }
            Ok(Self(value.to_string()))
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl<'de> ::serde::Deserialize<'de> for SessionId {
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
    ///`SessionInboxDelivery`
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
    pub enum SessionInboxDelivery {
        #[serde(rename = "steer")]
        Steer,
        #[serde(rename = "queue")]
        Queue,
    }
    impl ::std::fmt::Display for SessionInboxDelivery {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Steer => f.write_str("steer"),
                Self::Queue => f.write_str("queue"),
            }
        }
    }
    impl ::std::str::FromStr for SessionInboxDelivery {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "steer" => Ok(Self::Steer),
                "queue" => Ok(Self::Queue),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionInboxDelivery {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionInboxDelivery {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionInboxUser`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInboxUser {
        pub delivery: SessionInboxDelivery,
        pub id: SessionMessageId,
        pub payload: SessionInboxUserPayload,
        #[serde(rename = "sessionID")]
        pub session_id: SessionId,
        pub time: SessionInboxUserTime,
        #[serde(rename = "type")]
        pub type_: SessionInboxUserType,
    }
    ///`SessionInboxUserPayload`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInboxUserPayload {
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub agents: ::std::vec::Vec<PromptAgentAttachment>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub files: ::std::vec::Vec<PromptFileAttachment>,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub skills: ::std::vec::Vec<PromptSkillAttachment>,
        pub text: ::std::string::String,
    }
    ///`SessionInboxUserTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInboxUserTime {
        pub created: f64,
    }
    ///`SessionInboxUserType`
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
    pub enum SessionInboxUserType {
        #[serde(rename = "user")]
        User,
    }
    impl ::std::fmt::Display for SessionInboxUserType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::User => f.write_str("user"),
            }
        }
    }
    impl ::std::str::FromStr for SessionInboxUserType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "user" => Ok(Self::User),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionInboxUserType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionInboxUserType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionInfo`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInfo {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub agent: ::std::option::Option<AgentId>,
        pub cost: MoneyUsd,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub fork: ::std::option::Option<SessionInfoFork>,
        pub id: SessionId,
        pub location: LocationPublicRef,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub metadata: ::std::option::Option<SessionMetadata>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub model: ::std::option::Option<ModelRef>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub outcome: ::std::option::Option<SessionInfoOutcome>,
        #[serde(
            rename = "parentID",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub parent_id: ::std::option::Option<SessionId>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub permissions: ::std::option::Option<PermissionRuleset>,
        #[serde(rename = "projectID")]
        pub project_id: ProjectId,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub revert: ::std::option::Option<SessionRevert>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub subpath: ::std::option::Option<RelativePath>,
        pub time: SessionInfoTime,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub title: ::std::option::Option<::std::string::String>,
        pub tokens: TokenUsageInfo,
    }
    ///`SessionInfoFork`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInfoFork {
        pub boundary: SessionForkBoundary,
        #[serde(rename = "sessionID")]
        pub session_id: SessionId,
    }
    ///`SessionInfoOutcome`
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
    pub enum SessionInfoOutcome {
        #[serde(rename = "succeeded")]
        Succeeded,
        #[serde(rename = "failed")]
        Failed,
        #[serde(rename = "interrupted")]
        Interrupted,
    }
    impl ::std::fmt::Display for SessionInfoOutcome {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Succeeded => f.write_str("succeeded"),
                Self::Failed => f.write_str("failed"),
                Self::Interrupted => f.write_str("interrupted"),
            }
        }
    }
    impl ::std::str::FromStr for SessionInfoOutcome {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "succeeded" => Ok(Self::Succeeded),
                "failed" => Ok(Self::Failed),
                "interrupted" => Ok(Self::Interrupted),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionInfoOutcome {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionInfoOutcome {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionInfoTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInfoTime {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub archived: ::std::option::Option<f64>,
        pub created: f64,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub idle: ::std::option::Option<f64>,
        pub updated: f64,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub viewed: ::std::option::Option<f64>,
    }
    ///`SessionInterruptResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionInterruptResponse {
        ///Whether an active execution owned by this OpenCode process was interrupted.
        pub interrupted: bool,
    }
    ///`SessionInterruptResume`
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
    pub enum SessionInterruptResume {
        #[serde(rename = "true")]
        True,
        #[serde(rename = "false")]
        False,
    }
    impl ::std::fmt::Display for SessionInterruptResume {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::True => f.write_str("true"),
                Self::False => f.write_str("false"),
            }
        }
    }
    impl ::std::str::FromStr for SessionInterruptResume {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "true" => Ok(Self::True),
                "false" => Ok(Self::False),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionInterruptResume {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionInterruptResume {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageAgentSelected`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAgentSelected {
        pub agent: AgentId,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub previous: ::std::option::Option<AgentId>,
        pub time: SessionMessageAgentSelectedTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageAgentSelectedType,
    }
    ///`SessionMessageAgentSelectedTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAgentSelectedTime {
        pub created: f64,
    }
    ///`SessionMessageAgentSelectedType`
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
    pub enum SessionMessageAgentSelectedType {
        #[serde(rename = "agent-switched")]
        AgentSwitched,
    }
    impl ::std::fmt::Display for SessionMessageAgentSelectedType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::AgentSwitched => f.write_str("agent-switched"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageAgentSelectedType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "agent-switched" => Ok(Self::AgentSwitched),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageAgentSelectedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageAgentSelectedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageAssistant`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistant {
        pub agent: AgentId,
        pub content: ::std::vec::Vec<SessionMessageAssistantContentItem>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub cost: ::std::option::Option<MoneyUsd>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub error: ::std::option::Option<SessionStructuredError>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub finish: ::std::option::Option<SessionMessageAssistantFinish>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub model: ModelRef,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub native: ::std::option::Option<SessionMessageNative3>,
        #[serde(
            rename = "rawFinish",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub raw_finish: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub retry: ::std::option::Option<SessionMessageAssistantRetry>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub snapshot: ::std::option::Option<SessionMessageAssistantSnapshot>,
        pub time: SessionMessageAssistantTime,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub tokens: ::std::option::Option<TokenUsageInfo>,
        #[serde(rename = "type")]
        pub type_: SessionMessageAssistantType,
    }
    ///`SessionMessageAssistantContentItem`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum SessionMessageAssistantContentItem {
        Text(SessionMessageAssistantText),
        Reasoning(SessionMessageAssistantReasoning),
        Tool(SessionMessageAssistantTool),
    }
    impl ::std::convert::From<SessionMessageAssistantText>
    for SessionMessageAssistantContentItem {
        fn from(value: SessionMessageAssistantText) -> Self {
            Self::Text(value)
        }
    }
    impl ::std::convert::From<SessionMessageAssistantReasoning>
    for SessionMessageAssistantContentItem {
        fn from(value: SessionMessageAssistantReasoning) -> Self {
            Self::Reasoning(value)
        }
    }
    impl ::std::convert::From<SessionMessageAssistantTool>
    for SessionMessageAssistantContentItem {
        fn from(value: SessionMessageAssistantTool) -> Self {
            Self::Tool(value)
        }
    }
    ///`SessionMessageAssistantFinish`
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
    pub enum SessionMessageAssistantFinish {
        #[serde(rename = "stop")]
        Stop,
        #[serde(rename = "length")]
        Length,
        #[serde(rename = "tool-calls")]
        ToolCalls,
        #[serde(rename = "content-filter")]
        ContentFilter,
        #[serde(rename = "error")]
        Error,
        #[serde(rename = "unknown")]
        Unknown,
    }
    impl ::std::fmt::Display for SessionMessageAssistantFinish {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Stop => f.write_str("stop"),
                Self::Length => f.write_str("length"),
                Self::ToolCalls => f.write_str("tool-calls"),
                Self::ContentFilter => f.write_str("content-filter"),
                Self::Error => f.write_str("error"),
                Self::Unknown => f.write_str("unknown"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageAssistantFinish {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "stop" => Ok(Self::Stop),
                "length" => Ok(Self::Length),
                "tool-calls" => Ok(Self::ToolCalls),
                "content-filter" => Ok(Self::ContentFilter),
                "error" => Ok(Self::Error),
                "unknown" => Ok(Self::Unknown),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageAssistantFinish {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageAssistantFinish {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageAssistantReasoning`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantReasoning {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub native: ::std::option::Option<SessionMessageNative1>,
        pub text: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub time: ::std::option::Option<SessionMessageAssistantReasoningTime>,
        #[serde(rename = "type")]
        pub type_: SessionMessageAssistantReasoningType,
    }
    ///`SessionMessageAssistantReasoningTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantReasoningTime {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub completed: ::std::option::Option<f64>,
        pub created: f64,
    }
    ///`SessionMessageAssistantReasoningType`
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
    pub enum SessionMessageAssistantReasoningType {
        #[serde(rename = "reasoning")]
        Reasoning,
    }
    impl ::std::fmt::Display for SessionMessageAssistantReasoningType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Reasoning => f.write_str("reasoning"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageAssistantReasoningType {
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
    impl ::std::convert::TryFrom<&str> for SessionMessageAssistantReasoningType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageAssistantReasoningType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageAssistantRetry`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantRetry {
        pub at: f64,
        pub attempt: ::std::num::NonZeroU64,
        pub error: SessionStructuredError,
    }
    ///`SessionMessageAssistantSnapshot`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantSnapshot {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub end: ::std::option::Option<SnapshotId>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub files: ::std::vec::Vec<RelativePath>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub start: ::std::option::Option<SnapshotId>,
    }
    ///`SessionMessageAssistantText`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantText {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub native: ::std::option::Option<SessionMessageNative>,
        pub text: ::std::string::String,
        #[serde(rename = "type")]
        pub type_: SessionMessageAssistantTextType,
    }
    ///`SessionMessageAssistantTextType`
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
    pub enum SessionMessageAssistantTextType {
        #[serde(rename = "text")]
        Text,
    }
    impl ::std::fmt::Display for SessionMessageAssistantTextType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Text => f.write_str("text"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageAssistantTextType {
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
    impl ::std::convert::TryFrom<&str> for SessionMessageAssistantTextType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageAssistantTextType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageAssistantTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantTime {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub completed: ::std::option::Option<f64>,
        pub created: f64,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub streamed: ::std::option::Option<f64>,
    }
    ///`SessionMessageAssistantTool`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantTool {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub executed: ::std::option::Option<bool>,
        pub id: ::std::string::String,
        pub name: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub native: ::std::option::Option<SessionMessageNative2>,
        pub state: SessionMessageAssistantToolState,
        pub time: SessionMessageAssistantToolTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageAssistantToolType,
    }
    ///`SessionMessageAssistantToolState`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum SessionMessageAssistantToolState {
        Streaming(SessionMessageToolStateStreaming),
        Running(SessionMessageToolStateRunning),
        Completed(SessionMessageToolStateCompleted),
        Error(SessionMessageToolStateError),
    }
    impl ::std::convert::From<SessionMessageToolStateStreaming>
    for SessionMessageAssistantToolState {
        fn from(value: SessionMessageToolStateStreaming) -> Self {
            Self::Streaming(value)
        }
    }
    impl ::std::convert::From<SessionMessageToolStateRunning>
    for SessionMessageAssistantToolState {
        fn from(value: SessionMessageToolStateRunning) -> Self {
            Self::Running(value)
        }
    }
    impl ::std::convert::From<SessionMessageToolStateCompleted>
    for SessionMessageAssistantToolState {
        fn from(value: SessionMessageToolStateCompleted) -> Self {
            Self::Completed(value)
        }
    }
    impl ::std::convert::From<SessionMessageToolStateError>
    for SessionMessageAssistantToolState {
        fn from(value: SessionMessageToolStateError) -> Self {
            Self::Error(value)
        }
    }
    ///`SessionMessageAssistantToolTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageAssistantToolTime {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub completed: ::std::option::Option<f64>,
        pub created: f64,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub ran: ::std::option::Option<f64>,
    }
    ///`SessionMessageAssistantToolType`
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
    pub enum SessionMessageAssistantToolType {
        #[serde(rename = "tool")]
        Tool,
    }
    impl ::std::fmt::Display for SessionMessageAssistantToolType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Tool => f.write_str("tool"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageAssistantToolType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "tool" => Ok(Self::Tool),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageAssistantToolType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageAssistantToolType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageAssistantType`
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
    pub enum SessionMessageAssistantType {
        #[serde(rename = "assistant")]
        Assistant,
    }
    impl ::std::fmt::Display for SessionMessageAssistantType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Assistant => f.write_str("assistant"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageAssistantType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "assistant" => Ok(Self::Assistant),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageAssistantType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageAssistantType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompaction`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum SessionMessageCompaction {
        Running(SessionMessageCompactionRunning),
        Completed(SessionMessageCompactionCompleted),
        Failed(SessionMessageCompactionFailed),
    }
    impl ::std::convert::From<SessionMessageCompactionRunning>
    for SessionMessageCompaction {
        fn from(value: SessionMessageCompactionRunning) -> Self {
            Self::Running(value)
        }
    }
    impl ::std::convert::From<SessionMessageCompactionCompleted>
    for SessionMessageCompaction {
        fn from(value: SessionMessageCompactionCompleted) -> Self {
            Self::Completed(value)
        }
    }
    impl ::std::convert::From<SessionMessageCompactionFailed>
    for SessionMessageCompaction {
        fn from(value: SessionMessageCompactionFailed) -> Self {
            Self::Failed(value)
        }
    }
    ///`SessionMessageCompactionCompleted`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageCompactionCompleted {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub cost: ::std::option::Option<MoneyUsd>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub model: ::std::option::Option<ModelRef>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub native: ::std::option::Option<SessionMessageNative4>,
        pub reason: SessionMessageCompactionCompletedReason,
        pub status: SessionMessageCompactionCompletedStatus,
        pub summary: ::std::string::String,
        pub time: SessionMessageCompactionCompletedTime,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub tokens: ::std::option::Option<TokenUsageInfo>,
        #[serde(rename = "type")]
        pub type_: SessionMessageCompactionCompletedType,
    }
    ///`SessionMessageCompactionCompletedReason`
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
    pub enum SessionMessageCompactionCompletedReason {
        #[serde(rename = "auto")]
        Auto,
        #[serde(rename = "manual")]
        Manual,
    }
    impl ::std::fmt::Display for SessionMessageCompactionCompletedReason {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Auto => f.write_str("auto"),
                Self::Manual => f.write_str("manual"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionCompletedReason {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "auto" => Ok(Self::Auto),
                "manual" => Ok(Self::Manual),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionCompletedReason {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionCompletedReason {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionCompletedStatus`
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
    pub enum SessionMessageCompactionCompletedStatus {
        #[serde(rename = "completed")]
        Completed,
    }
    impl ::std::fmt::Display for SessionMessageCompactionCompletedStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Completed => f.write_str("completed"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionCompletedStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "completed" => Ok(Self::Completed),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionCompletedStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionCompletedStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionCompletedTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageCompactionCompletedTime {
        pub created: f64,
    }
    ///`SessionMessageCompactionCompletedType`
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
    pub enum SessionMessageCompactionCompletedType {
        #[serde(rename = "compaction")]
        Compaction,
    }
    impl ::std::fmt::Display for SessionMessageCompactionCompletedType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Compaction => f.write_str("compaction"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionCompletedType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "compaction" => Ok(Self::Compaction),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionCompletedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionCompletedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionFailed`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageCompactionFailed {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub cost: ::std::option::Option<MoneyUsd>,
        pub error: SessionStructuredError,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub reason: SessionMessageCompactionFailedReason,
        pub status: SessionMessageCompactionFailedStatus,
        pub time: SessionMessageCompactionFailedTime,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub tokens: ::std::option::Option<TokenUsageInfo>,
        #[serde(rename = "type")]
        pub type_: SessionMessageCompactionFailedType,
    }
    ///`SessionMessageCompactionFailedReason`
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
    pub enum SessionMessageCompactionFailedReason {
        #[serde(rename = "auto")]
        Auto,
        #[serde(rename = "manual")]
        Manual,
    }
    impl ::std::fmt::Display for SessionMessageCompactionFailedReason {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Auto => f.write_str("auto"),
                Self::Manual => f.write_str("manual"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionFailedReason {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "auto" => Ok(Self::Auto),
                "manual" => Ok(Self::Manual),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionFailedReason {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionFailedReason {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionFailedStatus`
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
    pub enum SessionMessageCompactionFailedStatus {
        #[serde(rename = "failed")]
        Failed,
    }
    impl ::std::fmt::Display for SessionMessageCompactionFailedStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Failed => f.write_str("failed"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionFailedStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "failed" => Ok(Self::Failed),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionFailedStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionFailedStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionFailedTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageCompactionFailedTime {
        pub created: f64,
    }
    ///`SessionMessageCompactionFailedType`
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
    pub enum SessionMessageCompactionFailedType {
        #[serde(rename = "compaction")]
        Compaction,
    }
    impl ::std::fmt::Display for SessionMessageCompactionFailedType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Compaction => f.write_str("compaction"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionFailedType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "compaction" => Ok(Self::Compaction),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionFailedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionFailedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionRunning`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageCompactionRunning {
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub reason: SessionMessageCompactionRunningReason,
        pub status: SessionMessageCompactionRunningStatus,
        pub summary: ::std::string::String,
        pub time: SessionMessageCompactionRunningTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageCompactionRunningType,
    }
    ///`SessionMessageCompactionRunningReason`
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
    pub enum SessionMessageCompactionRunningReason {
        #[serde(rename = "auto")]
        Auto,
        #[serde(rename = "manual")]
        Manual,
    }
    impl ::std::fmt::Display for SessionMessageCompactionRunningReason {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Auto => f.write_str("auto"),
                Self::Manual => f.write_str("manual"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionRunningReason {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "auto" => Ok(Self::Auto),
                "manual" => Ok(Self::Manual),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionRunningReason {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionRunningReason {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionRunningStatus`
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
    pub enum SessionMessageCompactionRunningStatus {
        #[serde(rename = "running")]
        Running,
    }
    impl ::std::fmt::Display for SessionMessageCompactionRunningStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Running => f.write_str("running"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionRunningStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "running" => Ok(Self::Running),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionRunningStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionRunningStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageCompactionRunningTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageCompactionRunningTime {
        pub created: f64,
    }
    ///`SessionMessageCompactionRunningType`
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
    pub enum SessionMessageCompactionRunningType {
        #[serde(rename = "compaction")]
        Compaction,
    }
    impl ::std::fmt::Display for SessionMessageCompactionRunningType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Compaction => f.write_str("compaction"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageCompactionRunningType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "compaction" => Ok(Self::Compaction),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageCompactionRunningType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageCompactionRunningType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageId`
    #[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    #[serde(transparent)]
    pub struct SessionMessageId(::std::string::String);
    impl ::std::ops::Deref for SessionMessageId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMessageId> for ::std::string::String {
        fn from(value: SessionMessageId) -> Self {
            value.0
        }
    }
    impl ::std::str::FromStr for SessionMessageId {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
            { ::regress::Regex::new("^msg_").unwrap() });
            if PATTERN.find(value).is_none() {
                return Err("doesn't match pattern \"^msg_\"".into());
            }
            Ok(Self(value.to_string()))
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl<'de> ::serde::Deserialize<'de> for SessionMessageId {
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
    ///`SessionMessageIdle`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageIdle {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub error: ::std::option::Option<SessionStructuredError>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub outcome: SessionMessageIdleOutcome,
        pub time: SessionMessageIdleTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageIdleType,
    }
    ///`SessionMessageIdleOutcome`
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
    pub enum SessionMessageIdleOutcome {
        #[serde(rename = "succeeded")]
        Succeeded,
        #[serde(rename = "failed")]
        Failed,
        #[serde(rename = "interrupted")]
        Interrupted,
    }
    impl ::std::fmt::Display for SessionMessageIdleOutcome {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Succeeded => f.write_str("succeeded"),
                Self::Failed => f.write_str("failed"),
                Self::Interrupted => f.write_str("interrupted"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageIdleOutcome {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "succeeded" => Ok(Self::Succeeded),
                "failed" => Ok(Self::Failed),
                "interrupted" => Ok(Self::Interrupted),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageIdleOutcome {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageIdleOutcome {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageIdleTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageIdleTime {
        pub created: f64,
    }
    ///`SessionMessageIdleType`
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
    pub enum SessionMessageIdleType {
        #[serde(rename = "idle")]
        Idle,
    }
    impl ::std::fmt::Display for SessionMessageIdleType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Idle => f.write_str("idle"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageIdleType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "idle" => Ok(Self::Idle),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageIdleType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageIdleType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageInfo`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum SessionMessageInfo {
        AgentSelected(SessionMessageAgentSelected),
        ModelSelected(SessionMessageModelSelected),
        LocationSwitched(SessionMessageLocationSwitched),
        User(SessionMessageUser),
        Synthetic(SessionMessageSynthetic),
        System(SessionMessageSystem),
        Skill(SessionMessageSkill),
        Shell(SessionMessageShell),
        Assistant(SessionMessageAssistant),
        Compaction(SessionMessageCompaction),
        Idle(SessionMessageIdle),
    }
    impl ::std::convert::From<SessionMessageAgentSelected> for SessionMessageInfo {
        fn from(value: SessionMessageAgentSelected) -> Self {
            Self::AgentSelected(value)
        }
    }
    impl ::std::convert::From<SessionMessageModelSelected> for SessionMessageInfo {
        fn from(value: SessionMessageModelSelected) -> Self {
            Self::ModelSelected(value)
        }
    }
    impl ::std::convert::From<SessionMessageLocationSwitched> for SessionMessageInfo {
        fn from(value: SessionMessageLocationSwitched) -> Self {
            Self::LocationSwitched(value)
        }
    }
    impl ::std::convert::From<SessionMessageUser> for SessionMessageInfo {
        fn from(value: SessionMessageUser) -> Self {
            Self::User(value)
        }
    }
    impl ::std::convert::From<SessionMessageSynthetic> for SessionMessageInfo {
        fn from(value: SessionMessageSynthetic) -> Self {
            Self::Synthetic(value)
        }
    }
    impl ::std::convert::From<SessionMessageSystem> for SessionMessageInfo {
        fn from(value: SessionMessageSystem) -> Self {
            Self::System(value)
        }
    }
    impl ::std::convert::From<SessionMessageSkill> for SessionMessageInfo {
        fn from(value: SessionMessageSkill) -> Self {
            Self::Skill(value)
        }
    }
    impl ::std::convert::From<SessionMessageShell> for SessionMessageInfo {
        fn from(value: SessionMessageShell) -> Self {
            Self::Shell(value)
        }
    }
    impl ::std::convert::From<SessionMessageAssistant> for SessionMessageInfo {
        fn from(value: SessionMessageAssistant) -> Self {
            Self::Assistant(value)
        }
    }
    impl ::std::convert::From<SessionMessageCompaction> for SessionMessageInfo {
        fn from(value: SessionMessageCompaction) -> Self {
            Self::Compaction(value)
        }
    }
    impl ::std::convert::From<SessionMessageIdle> for SessionMessageInfo {
        fn from(value: SessionMessageIdle) -> Self {
            Self::Idle(value)
        }
    }
    ///Message order for the first page. Use desc for newest first or asc for oldest first.
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
    pub enum SessionMessageListOrder {
        #[serde(rename = "asc")]
        Asc,
        #[serde(rename = "desc")]
        Desc,
    }
    impl ::std::fmt::Display for SessionMessageListOrder {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Asc => f.write_str("asc"),
                Self::Desc => f.write_str("desc"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageListOrder {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "asc" => Ok(Self::Asc),
                "desc" => Ok(Self::Desc),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageListOrder {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageListOrder {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///Filter by message type before pagination. When omitted, all message types are returned. Pass the same type when following cursors.
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
    pub enum SessionMessageListType {
        #[serde(rename = "agent-switched")]
        AgentSwitched,
        #[serde(rename = "model-switched")]
        ModelSwitched,
        #[serde(rename = "location-switched")]
        LocationSwitched,
        #[serde(rename = "user")]
        User,
        #[serde(rename = "synthetic")]
        Synthetic,
        #[serde(rename = "system")]
        System,
        #[serde(rename = "skill")]
        Skill,
        #[serde(rename = "shell")]
        Shell,
        #[serde(rename = "assistant")]
        Assistant,
        #[serde(rename = "compaction")]
        Compaction,
        #[serde(rename = "idle")]
        Idle,
    }
    impl ::std::fmt::Display for SessionMessageListType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::AgentSwitched => f.write_str("agent-switched"),
                Self::ModelSwitched => f.write_str("model-switched"),
                Self::LocationSwitched => f.write_str("location-switched"),
                Self::User => f.write_str("user"),
                Self::Synthetic => f.write_str("synthetic"),
                Self::System => f.write_str("system"),
                Self::Skill => f.write_str("skill"),
                Self::Shell => f.write_str("shell"),
                Self::Assistant => f.write_str("assistant"),
                Self::Compaction => f.write_str("compaction"),
                Self::Idle => f.write_str("idle"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageListType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "agent-switched" => Ok(Self::AgentSwitched),
                "model-switched" => Ok(Self::ModelSwitched),
                "location-switched" => Ok(Self::LocationSwitched),
                "user" => Ok(Self::User),
                "synthetic" => Ok(Self::Synthetic),
                "system" => Ok(Self::System),
                "skill" => Ok(Self::Skill),
                "shell" => Ok(Self::Shell),
                "assistant" => Ok(Self::Assistant),
                "compaction" => Ok(Self::Compaction),
                "idle" => Ok(Self::Idle),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageListType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageListType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageLocationSwitched`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageLocationSwitched {
        pub id: SessionMessageId,
        pub location: LocationPublicRef,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub previous: ::std::option::Option<SessionMessageLocationSwitchedPrevious>,
        #[serde(
            rename = "projectID",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub project_id: ::std::option::Option<ProjectId>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub subpath: ::std::option::Option<RelativePath>,
        pub time: SessionMessageLocationSwitchedTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageLocationSwitchedType,
    }
    ///`SessionMessageLocationSwitchedPrevious`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageLocationSwitchedPrevious {
        pub location: LocationPublicRef,
        #[serde(
            rename = "projectID",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub project_id: ::std::option::Option<ProjectId>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub subpath: ::std::option::Option<RelativePath>,
    }
    ///`SessionMessageLocationSwitchedTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageLocationSwitchedTime {
        pub created: f64,
    }
    ///`SessionMessageLocationSwitchedType`
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
    pub enum SessionMessageLocationSwitchedType {
        #[serde(rename = "location-switched")]
        LocationSwitched,
    }
    impl ::std::fmt::Display for SessionMessageLocationSwitchedType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::LocationSwitched => f.write_str("location-switched"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageLocationSwitchedType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "location-switched" => Ok(Self::LocationSwitched),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageLocationSwitchedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageLocationSwitchedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageModelSelected`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageModelSelected {
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub model: ModelRef,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub previous: ::std::option::Option<ModelRef>,
        pub time: SessionMessageModelSelectedTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageModelSelectedType,
    }
    ///`SessionMessageModelSelectedTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageModelSelectedTime {
        pub created: f64,
    }
    ///`SessionMessageModelSelectedType`
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
    pub enum SessionMessageModelSelectedType {
        #[serde(rename = "model-switched")]
        ModelSwitched,
    }
    impl ::std::fmt::Display for SessionMessageModelSelectedType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::ModelSwitched => f.write_str("model-switched"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageModelSelectedType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "model-switched" => Ok(Self::ModelSwitched),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageModelSelectedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageModelSelectedType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageNative`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct SessionMessageNative(
        pub ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    );
    impl ::std::ops::Deref for SessionMessageNative {
        type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
        fn deref(
            &self,
        ) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMessageNative>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value> {
        fn from(value: SessionMessageNative) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    > for SessionMessageNative {
        fn from(
            value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        ) -> Self {
            Self(value)
        }
    }
    ///`SessionMessageNative1`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct SessionMessageNative1(
        pub ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    );
    impl ::std::ops::Deref for SessionMessageNative1 {
        type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
        fn deref(
            &self,
        ) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMessageNative1>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value> {
        fn from(value: SessionMessageNative1) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    > for SessionMessageNative1 {
        fn from(
            value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        ) -> Self {
            Self(value)
        }
    }
    ///`SessionMessageNative2`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct SessionMessageNative2(
        pub ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    );
    impl ::std::ops::Deref for SessionMessageNative2 {
        type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
        fn deref(
            &self,
        ) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMessageNative2>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value> {
        fn from(value: SessionMessageNative2) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    > for SessionMessageNative2 {
        fn from(
            value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        ) -> Self {
            Self(value)
        }
    }
    ///`SessionMessageNative3`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct SessionMessageNative3(
        pub ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    );
    impl ::std::ops::Deref for SessionMessageNative3 {
        type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
        fn deref(
            &self,
        ) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMessageNative3>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value> {
        fn from(value: SessionMessageNative3) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    > for SessionMessageNative3 {
        fn from(
            value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        ) -> Self {
            Self(value)
        }
    }
    ///`SessionMessageNative4`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct SessionMessageNative4(
        pub ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    );
    impl ::std::ops::Deref for SessionMessageNative4 {
        type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
        fn deref(
            &self,
        ) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMessageNative4>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value> {
        fn from(value: SessionMessageNative4) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    > for SessionMessageNative4 {
        fn from(
            value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        ) -> Self {
            Self(value)
        }
    }
    ///`SessionMessageShell`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageShell {
        pub command: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub exit: ::std::option::Option<SessionMessageShellExit>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub output: ::std::option::Option<SessionMessageShellOutput>,
        #[serde(rename = "shellID")]
        pub shell_id: ShellId,
        pub status: SessionMessageShellStatus,
        pub time: SessionMessageShellTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageShellType,
    }
    ///`SessionMessageShellExit`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum SessionMessageShellExit {
        Number(f64),
        String(SessionMessageShellExitString),
    }
    impl ::std::fmt::Display for SessionMessageShellExit {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                Self::Number(x) => x.fmt(f),
                Self::String(x) => x.fmt(f),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageShellExit {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            if let Ok(v) = value.parse() {
                Ok(Self::Number(v))
            } else if let Ok(v) = value.parse() {
                Ok(Self::String(v))
            } else {
                Err("string conversion failed for all variants".into())
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageShellExit {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageShellExit {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::From<f64> for SessionMessageShellExit {
        fn from(value: f64) -> Self {
            Self::Number(value)
        }
    }
    impl ::std::convert::From<SessionMessageShellExitString>
    for SessionMessageShellExit {
        fn from(value: SessionMessageShellExitString) -> Self {
            Self::String(value)
        }
    }
    ///`SessionMessageShellExitString`
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
    pub enum SessionMessageShellExitString {
        Infinity,
        #[serde(rename = "-Infinity")]
        XInfinity,
        NaN,
    }
    impl ::std::fmt::Display for SessionMessageShellExitString {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Infinity => f.write_str("Infinity"),
                Self::XInfinity => f.write_str("-Infinity"),
                Self::NaN => f.write_str("NaN"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageShellExitString {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "Infinity" => Ok(Self::Infinity),
                "-Infinity" => Ok(Self::XInfinity),
                "NaN" => Ok(Self::NaN),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageShellExitString {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageShellExitString {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageShellOutput`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageShellOutput {
        pub cursor: u64,
        pub output: ::std::string::String,
        pub size: u64,
        pub truncated: bool,
    }
    ///`SessionMessageShellStatus`
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
    pub enum SessionMessageShellStatus {
        #[serde(rename = "running")]
        Running,
        #[serde(rename = "exited")]
        Exited,
        #[serde(rename = "timeout")]
        Timeout,
        #[serde(rename = "killed")]
        Killed,
    }
    impl ::std::fmt::Display for SessionMessageShellStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Running => f.write_str("running"),
                Self::Exited => f.write_str("exited"),
                Self::Timeout => f.write_str("timeout"),
                Self::Killed => f.write_str("killed"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageShellStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "running" => Ok(Self::Running),
                "exited" => Ok(Self::Exited),
                "timeout" => Ok(Self::Timeout),
                "killed" => Ok(Self::Killed),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageShellStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageShellStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageShellTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageShellTime {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub completed: ::std::option::Option<f64>,
        pub created: f64,
    }
    ///`SessionMessageShellType`
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
    pub enum SessionMessageShellType {
        #[serde(rename = "shell")]
        Shell,
    }
    impl ::std::fmt::Display for SessionMessageShellType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Shell => f.write_str("shell"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageShellType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "shell" => Ok(Self::Shell),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageShellType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageShellType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageSkill`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageSkill {
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub name: SkillName,
        pub skill: SkillId,
        pub text: ::std::string::String,
        pub time: SessionMessageSkillTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageSkillType,
    }
    ///`SessionMessageSkillTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageSkillTime {
        pub created: f64,
    }
    ///`SessionMessageSkillType`
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
    pub enum SessionMessageSkillType {
        #[serde(rename = "skill")]
        Skill,
    }
    impl ::std::fmt::Display for SessionMessageSkillType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Skill => f.write_str("skill"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageSkillType {
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
    impl ::std::convert::TryFrom<&str> for SessionMessageSkillType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageSkillType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageSynthetic`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageSynthetic {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub description: ::std::option::Option<::std::string::String>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub text: ::std::string::String,
        pub time: SessionMessageSyntheticTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageSyntheticType,
    }
    ///`SessionMessageSyntheticTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageSyntheticTime {
        pub created: f64,
    }
    ///`SessionMessageSyntheticType`
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
    pub enum SessionMessageSyntheticType {
        #[serde(rename = "synthetic")]
        Synthetic,
    }
    impl ::std::fmt::Display for SessionMessageSyntheticType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Synthetic => f.write_str("synthetic"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageSyntheticType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "synthetic" => Ok(Self::Synthetic),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageSyntheticType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageSyntheticType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageSystem`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageSystem {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub description: ::std::option::Option<::std::string::String>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub text: ::std::string::String,
        pub time: SessionMessageSystemTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageSystemType,
    }
    ///`SessionMessageSystemTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageSystemTime {
        pub created: f64,
    }
    ///`SessionMessageSystemType`
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
    pub enum SessionMessageSystemType {
        #[serde(rename = "system")]
        System,
    }
    impl ::std::fmt::Display for SessionMessageSystemType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::System => f.write_str("system"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageSystemType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "system" => Ok(Self::System),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageSystemType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageSystemType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageToolStateCompleted`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageToolStateCompleted {
        pub content: ::std::vec::Vec<ToolContent>,
        pub input: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub status: SessionMessageToolStateCompletedStatus,
    }
    ///`SessionMessageToolStateCompletedStatus`
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
    pub enum SessionMessageToolStateCompletedStatus {
        #[serde(rename = "completed")]
        Completed,
    }
    impl ::std::fmt::Display for SessionMessageToolStateCompletedStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Completed => f.write_str("completed"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageToolStateCompletedStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "completed" => Ok(Self::Completed),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageToolStateCompletedStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageToolStateCompletedStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageToolStateError`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageToolStateError {
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub content: ::std::vec::Vec<ToolContent>,
        pub error: SessionStructuredError,
        pub input: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub status: SessionMessageToolStateErrorStatus,
    }
    ///`SessionMessageToolStateErrorStatus`
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
    pub enum SessionMessageToolStateErrorStatus {
        #[serde(rename = "error")]
        Error,
    }
    impl ::std::fmt::Display for SessionMessageToolStateErrorStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Error => f.write_str("error"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageToolStateErrorStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "error" => Ok(Self::Error),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageToolStateErrorStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageToolStateErrorStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageToolStateRunning`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageToolStateRunning {
        pub input: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        pub status: SessionMessageToolStateRunningStatus,
    }
    ///`SessionMessageToolStateRunningStatus`
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
    pub enum SessionMessageToolStateRunningStatus {
        #[serde(rename = "running")]
        Running,
    }
    impl ::std::fmt::Display for SessionMessageToolStateRunningStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Running => f.write_str("running"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageToolStateRunningStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "running" => Ok(Self::Running),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageToolStateRunningStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageToolStateRunningStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageToolStateStreaming`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageToolStateStreaming {
        pub input: ::std::string::String,
        pub status: SessionMessageToolStateStreamingStatus,
    }
    ///`SessionMessageToolStateStreamingStatus`
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
    pub enum SessionMessageToolStateStreamingStatus {
        #[serde(rename = "streaming")]
        Streaming,
    }
    impl ::std::fmt::Display for SessionMessageToolStateStreamingStatus {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Streaming => f.write_str("streaming"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageToolStateStreamingStatus {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "streaming" => Ok(Self::Streaming),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageToolStateStreamingStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionMessageToolStateStreamingStatus {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessageUser`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageUser {
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub agents: ::std::vec::Vec<PromptAgentAttachment>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub files: ::std::vec::Vec<PromptFileAttachment>,
        pub id: SessionMessageId,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub skills: ::std::vec::Vec<PromptSkillAttachment>,
        pub text: ::std::string::String,
        pub time: SessionMessageUserTime,
        #[serde(rename = "type")]
        pub type_: SessionMessageUserType,
    }
    ///`SessionMessageUserTime`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessageUserTime {
        pub created: f64,
    }
    ///`SessionMessageUserType`
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
    pub enum SessionMessageUserType {
        #[serde(rename = "user")]
        User,
    }
    impl ::std::fmt::Display for SessionMessageUserType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::User => f.write_str("user"),
            }
        }
    }
    impl ::std::str::FromStr for SessionMessageUserType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "user" => Ok(Self::User),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionMessageUserType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for SessionMessageUserType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionMessagesResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessagesResponse {
        pub cursor: SessionMessagesResponseCursor,
        pub data: ::std::vec::Vec<SessionMessageInfo>,
    }
    ///`SessionMessagesResponseCursor`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
    #[serde(deny_unknown_fields)]
    pub struct SessionMessagesResponseCursor {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub next: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub previous: ::std::option::Option<::std::string::String>,
    }
    ///`SessionMetadata`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(transparent)]
    pub struct SessionMetadata(
        pub ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    );
    impl ::std::ops::Deref for SessionMetadata {
        type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
        fn deref(
            &self,
        ) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
            &self.0
        }
    }
    impl ::std::convert::From<SessionMetadata>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value> {
        fn from(value: SessionMetadata) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<
        ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    > for SessionMetadata {
        fn from(
            value: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        ) -> Self {
            Self(value)
        }
    }
    ///`SessionNotFoundErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionNotFoundErrorEncoded {
        pub message: ::std::string::String,
        #[serde(rename = "sessionID")]
        pub session_id: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: SessionNotFoundErrorEncodedTag,
    }
    ///`SessionNotFoundErrorEncodedTag`
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
    pub enum SessionNotFoundErrorEncodedTag {
        SessionNotFoundError,
    }
    impl ::std::fmt::Display for SessionNotFoundErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::SessionNotFoundError => f.write_str("SessionNotFoundError"),
            }
        }
    }
    impl ::std::str::FromStr for SessionNotFoundErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "SessionNotFoundError" => Ok(Self::SessionNotFoundError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for SessionNotFoundErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String>
    for SessionNotFoundErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`SessionPermissionListResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionPermissionListResponse {
        pub data: ::std::vec::Vec<PermissionRequest>,
    }
    ///`SessionPermissionReplyBody`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionPermissionReplyBody {
        pub decision: PermissionReply,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub message: ::std::option::Option<::std::string::String>,
    }
    ///`SessionPromptBody`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionPromptBody {
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub agents: ::std::vec::Vec<PromptAgentAttachment>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub delivery: ::std::option::Option<SessionInboxDelivery>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub files: ::std::vec::Vec<PromptInputFileAttachment>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub id: ::std::option::Option<SessionMessageId>,
        #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
        pub metadata: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub resume: ::std::option::Option<bool>,
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub skills: ::std::vec::Vec<PromptInputSkillAttachment>,
        pub text: ::std::string::String,
    }
    ///`SessionPromptResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionPromptResponse {
        pub data: SessionInboxUser,
    }
    ///`SessionRevert`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionRevert {
        #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
        pub files: ::std::vec::Vec<FileDiffInfo>,
        #[serde(rename = "messageID")]
        pub message_id: SessionMessageId,
        #[serde(
            rename = "partID",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub part_id: ::std::option::Option<::std::string::String>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub snapshot: ::std::option::Option<SnapshotId>,
    }
    ///`SessionStructuredError`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionStructuredError {
        pub message: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub response: ::std::option::Option<SessionStructuredErrorResponse>,
        #[serde(
            rename = "retryAfterMs",
            skip_serializing_if = "::std::option::Option::is_none"
        )]
        pub retry_after_ms: ::std::option::Option<u64>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub status: ::std::option::Option<i64>,
        #[serde(rename = "type")]
        pub type_: ::std::string::String,
    }
    ///`SessionStructuredErrorResponse`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionStructuredErrorResponse {
        pub body: ::std::string::String,
    }
    ///`SessionSwitchModelBody`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct SessionSwitchModelBody {
        pub model: ModelRef,
    }
    ///`SessionUpdateBody`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
    #[serde(deny_unknown_fields)]
    pub struct SessionUpdateBody {
        ///Archive the session with true or restore it with false. Repeating the current state is a no-op.
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub archived: ::std::option::Option<bool>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub metadata: ::std::option::Option<SessionMetadata>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub permissions: ::std::option::Option<PermissionRuleset>,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub title: ::std::option::Option<::std::string::String>,
    }
    ///`ShellId`
    #[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    #[serde(transparent)]
    pub struct ShellId(::std::string::String);
    impl ::std::ops::Deref for ShellId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<ShellId> for ::std::string::String {
        fn from(value: ShellId) -> Self {
            value.0
        }
    }
    impl ::std::str::FromStr for ShellId {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
            { ::regress::Regex::new("^sh_").unwrap() });
            if PATTERN.find(value).is_none() {
                return Err("doesn't match pattern \"^sh_\"".into());
            }
            Ok(Self(value.to_string()))
        }
    }
    impl ::std::convert::TryFrom<&str> for ShellId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ShellId {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl<'de> ::serde::Deserialize<'de> for ShellId {
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
    ///`SkillId`
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
    pub struct SkillId(pub ::std::string::String);
    impl ::std::ops::Deref for SkillId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<SkillId> for ::std::string::String {
        fn from(value: SkillId) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for SkillId {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for SkillId {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for SkillId {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`SkillName`
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
    pub struct SkillName(pub ::std::string::String);
    impl ::std::ops::Deref for SkillName {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<SkillName> for ::std::string::String {
        fn from(value: SkillName) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for SkillName {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for SkillName {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for SkillName {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`SnapshotId`
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
    pub struct SnapshotId(pub ::std::string::String);
    impl ::std::ops::Deref for SnapshotId {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<SnapshotId> for ::std::string::String {
        fn from(value: SnapshotId) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for SnapshotId {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for SnapshotId {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for SnapshotId {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
        }
    }
    ///`TokenUsageInfo`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct TokenUsageInfo {
        pub cache: TokenUsageInfoCache,
        pub input: f64,
        pub output: f64,
        pub reasoning: f64,
    }
    ///`TokenUsageInfoCache`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct TokenUsageInfoCache {
        pub read: f64,
        pub write: f64,
    }
    ///`ToolContent`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(untagged)]
    pub enum ToolContent {
        TextContent(ToolTextContent),
        FileContent(ToolFileContent),
    }
    impl ::std::convert::From<ToolTextContent> for ToolContent {
        fn from(value: ToolTextContent) -> Self {
            Self::TextContent(value)
        }
    }
    impl ::std::convert::From<ToolFileContent> for ToolContent {
        fn from(value: ToolFileContent) -> Self {
            Self::FileContent(value)
        }
    }
    ///`ToolFileContent`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ToolFileContent {
        pub mime: ::std::string::String,
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        pub name: ::std::option::Option<::std::string::String>,
        #[serde(rename = "type")]
        pub type_: ToolFileContentType,
        pub uri: ::std::string::String,
    }
    ///`ToolFileContentType`
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
    pub enum ToolFileContentType {
        #[serde(rename = "file")]
        File,
    }
    impl ::std::fmt::Display for ToolFileContentType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::File => f.write_str("file"),
            }
        }
    }
    impl ::std::str::FromStr for ToolFileContentType {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "file" => Ok(Self::File),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for ToolFileContentType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ToolFileContentType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`ToolTextContent`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct ToolTextContent {
        pub text: ::std::string::String,
        #[serde(rename = "type")]
        pub type_: ToolTextContentType,
    }
    ///`ToolTextContentType`
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
    pub enum ToolTextContentType {
        #[serde(rename = "text")]
        Text,
    }
    impl ::std::fmt::Display for ToolTextContentType {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::Text => f.write_str("text"),
            }
        }
    }
    impl ::std::str::FromStr for ToolTextContentType {
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
    impl ::std::convert::TryFrom<&str> for ToolTextContentType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for ToolTextContentType {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`UnauthorizedErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct UnauthorizedErrorEncoded {
        pub message: ::std::string::String,
        #[serde(rename = "_tag")]
        pub tag: UnauthorizedErrorEncodedTag,
    }
    ///`UnauthorizedErrorEncodedTag`
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
    pub enum UnauthorizedErrorEncodedTag {
        UnauthorizedError,
    }
    impl ::std::fmt::Display for UnauthorizedErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::UnauthorizedError => f.write_str("UnauthorizedError"),
            }
        }
    }
    impl ::std::str::FromStr for UnauthorizedErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "UnauthorizedError" => Ok(Self::UnauthorizedError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for UnauthorizedErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for UnauthorizedErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`UnknownErrorEncoded`
    #[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
    #[serde(deny_unknown_fields)]
    pub struct UnknownErrorEncoded {
        pub message: ::std::string::String,
        #[serde(rename = "ref", skip_serializing_if = "::std::option::Option::is_none")]
        pub ref_: ::std::option::Option<::std::string::String>,
        #[serde(rename = "_tag")]
        pub tag: UnknownErrorEncodedTag,
    }
    ///`UnknownErrorEncodedTag`
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
    pub enum UnknownErrorEncodedTag {
        UnknownError,
    }
    impl ::std::fmt::Display for UnknownErrorEncodedTag {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match *self {
                Self::UnknownError => f.write_str("UnknownError"),
            }
        }
    }
    impl ::std::str::FromStr for UnknownErrorEncodedTag {
        type Err = self::error::ConversionError;
        fn from_str(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            match value {
                "UnknownError" => Ok(Self::UnknownError),
                _ => Err("invalid value".into()),
            }
        }
    }
    impl ::std::convert::TryFrom<&str> for UnknownErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: &str,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    impl ::std::convert::TryFrom<::std::string::String> for UnknownErrorEncodedTag {
        type Error = self::error::ConversionError;
        fn try_from(
            value: ::std::string::String,
        ) -> ::std::result::Result<Self, self::error::ConversionError> {
            value.parse()
        }
    }
    ///`V2EventEncoded`
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
    pub struct V2EventEncoded(pub ::std::string::String);
    impl ::std::ops::Deref for V2EventEncoded {
        type Target = ::std::string::String;
        fn deref(&self) -> &::std::string::String {
            &self.0
        }
    }
    impl ::std::convert::From<V2EventEncoded> for ::std::string::String {
        fn from(value: V2EventEncoded) -> Self {
            value.0
        }
    }
    impl ::std::convert::From<::std::string::String> for V2EventEncoded {
        fn from(value: ::std::string::String) -> Self {
            Self(value)
        }
    }
    impl ::std::fmt::Display for V2EventEncoded {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            self.0.fmt(f)
        }
    }
    impl ::std::str::FromStr for V2EventEncoded {
        type Err = ::std::convert::Infallible;
        fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
            Ok(Self(value.to_string()))
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
}
#[derive(Clone, Debug)]
/**Client for opencode HttpApi

Experimental HttpApi surface for selected instance routes.

Version: 0.0.1*/
pub struct Client {
    pub(crate) baseurl: String,
    pub(crate) client: reqwest013::Client,
}
impl Client {
    /// Create a new client.
    ///
    /// `baseurl` is the base URL provided to the internal
    /// `reqwest013::Client`, and should include a scheme and hostname,
    /// as well as port and a path stem if applicable.
    ///
    /// Returns an error if the `reqwest013::Client` cannot be built,
    /// for example when the TLS backend fails to initialize.
    pub fn new(baseurl: &str) -> Result<Self, reqwest013::Error> {
        #[cfg(not(target_arch = "wasm32"))]
        let client = {
            let dur = ::std::time::Duration::from_secs(15u64);
            reqwest013::ClientBuilder::new().connect_timeout(dur).timeout(dur)
        };
        #[cfg(target_arch = "wasm32")]
        let client = reqwest013::ClientBuilder::new();
        Ok(Self::new_with_client(baseurl, client.build()?))
    }
    /// Construct a new client with an existing `reqwest013::Client`,
    /// allowing more control over its configuration.
    ///
    /// `baseurl` is the base URL provided to the internal
    /// `reqwest013::Client`, and should include a scheme and hostname,
    /// as well as port and a path stem if applicable.
    pub fn new_with_client(baseurl: &str, client: reqwest013::Client) -> Self {
        Self {
            baseurl: baseurl.to_string(),
            client,
        }
    }
}
impl ClientInfo<()> for Client {
    fn api_version() -> &'static str {
        "0.0.1"
    }
    fn baseurl(&self) -> &str {
        self.baseurl.as_str()
    }
    fn client(&self) -> &reqwest013::Client {
        &self.client
    }
    fn inner(&self) -> &() {
        &()
    }
}
impl ClientHooks<()> for &Client {}
#[allow(clippy::all)]
impl Client {
    /**Subscribe to events

Subscribe to native events and plugin RPC events across all server locations. Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed.

Sends a `GET` request to `/api/event`

*/
    pub async fn event_subscribe<'a>(
        &'a self,
    ) -> Result<
        ResponseValue<ByteStream>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!("{}/api/event", self.baseurl,);
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self.client.get(url).headers(header_map).build()?;
        let info = OperationInfo {
            operation_id: "event_subscribe",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => Ok(ResponseValue::stream(response)),
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Put instruction entry

Attach or replace one durable instruction entry. Changes announce as updates at the next step boundary.

Sends a `PUT` request to `/api/experimental/session/{sessionID}/instructions/entries/{key}`

*/
    pub async fn experimental_session_instructions_entry_put<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        key: &'a types::InstructionEntryKey,
        body: &'a types::ExperimentalSessionInstructionsEntryPutBody,
    ) -> Result<
        ResponseValue<()>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/experimental/session/{}/instructions/entries/{}", self.baseurl,
            encode_path(& session_id.to_string()), encode_path(& key.to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .put(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "experimental_session_instructions_entry_put",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            204u16 => Ok(ResponseValue::empty(response)),
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Get server info

Return the server identity, connection URLs, paths, and readiness status.

Sends a `GET` request to `/api/info`

*/
    pub async fn server_info<'a>(
        &'a self,
    ) -> Result<
        ResponseValue<types::ServerInfo>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!("{}/api/info", self.baseurl,);
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .get(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "server_info",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**List models

Retrieve the current snapshot of available models ordered by release date. The snapshot may precede initial plugin settlement.

Sends a `GET` request to `/api/model`

*/
    pub async fn model_list<'a>(
        &'a self,
        location_directory: Option<&'a str>,
    ) -> Result<
        ResponseValue<types::ModelListResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!("{}/api/model", self.baseurl,);
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .get(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .query(&QueryParam::new("location[directory]", &location_directory))
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "model_list",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Create pairing code

Create a short-lived, single-use code for a /auth/connect/:code pairing link.

Sends a `POST` request to `/api/pair`

*/
    pub async fn server_pair<'a>(
        &'a self,
    ) -> Result<
        ResponseValue<types::PairingCode>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!("{}/api/pair", self.baseurl,);
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .post(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "server_pair",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Create session

Create a session at the requested location. A parentID creates a linked child session at its parent's location.

Sends a `POST` request to `/api/session`

*/
    pub async fn session_create<'a>(
        &'a self,
        body: &'a types::SessionCreateBody,
    ) -> Result<
        ResponseValue<types::SessionCreateResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!("{}/api/session", self.baseurl,);
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .post(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_create",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Get session

Retrieve a session by ID.

Sends a `GET` request to `/api/session/{sessionID}`

*/
    pub async fn session_get<'a>(
        &'a self,
        session_id: &'a types::SessionId,
    ) -> Result<
        ResponseValue<types::SessionGetResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}", self.baseurl, encode_path(& session_id.to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .get(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_get",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Delete session

Delete a session and its child sessions.

Sends a `DELETE` request to `/api/session/{sessionID}`

*/
    pub async fn session_remove<'a>(
        &'a self,
        session_id: &'a types::SessionId,
    ) -> Result<
        ResponseValue<()>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}", self.baseurl, encode_path(& session_id.to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .delete(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_remove",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            204u16 => Ok(ResponseValue::empty(response)),
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Update session

Update mutable session properties.

Sends a `PATCH` request to `/api/session/{sessionID}`

*/
    pub async fn session_update<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        body: &'a types::SessionUpdateBody,
    ) -> Result<
        ResponseValue<()>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}", self.baseurl, encode_path(& session_id.to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .patch(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_update",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            204u16 => Ok(ResponseValue::empty(response)),
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Interrupt session execution

Interrupt active execution owned by this OpenCode process. Returns interrupted=true when an active execution was interrupted and false for the idle no-op. When resume=true, execution resumes pending steering input and next-in-line control items (manual compaction, moves) while queued prompts remain parked.

Sends a `POST` request to `/api/session/{sessionID}/interrupt`

*/
    pub async fn session_interrupt<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        resume: Option<types::SessionInterruptResume>,
    ) -> Result<
        ResponseValue<types::SessionInterruptResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}/interrupt", self.baseurl, encode_path(& session_id
            .to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .post(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .query(&QueryParam::new("resume", &resume))
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_interrupt",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Get session messages

Retrieve projected messages for a session, optionally filtered by type. Items keep the requested order across pages; use cursor.next or cursor.previous to move through the ordered timeline, passing the same type filter on each page.

Sends a `GET` request to `/api/session/{sessionID}/message`

*/
    pub async fn session_message_list<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        cursor: Option<&'a str>,
        limit: Option<&'a str>,
        order: Option<types::SessionMessageListOrder>,
        type_: Option<types::SessionMessageListType>,
    ) -> Result<
        ResponseValue<types::SessionMessagesResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}/message", self.baseurl, encode_path(& session_id
            .to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .get(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .query(&QueryParam::new("cursor", &cursor))
            .query(&QueryParam::new("limit", &limit))
            .query(&QueryParam::new("order", &order))
            .query(&QueryParam::new("type", &type_))
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_message_list",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Switch session model

Switch the model used by subsequent provider turns.

Sends a `POST` request to `/api/session/{sessionID}/model`

*/
    pub async fn session_switch_model<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        body: &'a types::SessionSwitchModelBody,
    ) -> Result<
        ResponseValue<()>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}/model", self.baseurl, encode_path(& session_id
            .to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .post(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_switch_model",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            204u16 => Ok(ResponseValue::empty(response)),
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**List session permission requests

Retrieve pending permission requests owned by a session.

Sends a `GET` request to `/api/session/{sessionID}/permission`

*/
    pub async fn session_permission_list<'a>(
        &'a self,
        session_id: &'a types::SessionId,
    ) -> Result<
        ResponseValue<types::SessionPermissionListResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}/permission", self.baseurl, encode_path(& session_id
            .to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .get(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_permission_list",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Reply to pending permission request

Respond to a pending permission request owned by a session.

Sends a `POST` request to `/api/session/{sessionID}/permission/{requestID}/reply`

*/
    pub async fn session_permission_reply<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        request_id: &'a types::PermissionId,
        body: &'a types::SessionPermissionReplyBody,
    ) -> Result<
        ResponseValue<()>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}/permission/{}/reply", self.baseurl, encode_path(&
            session_id.to_string()), encode_path(& request_id.to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .post(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_permission_reply",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            204u16 => Ok(ResponseValue::empty(response)),
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Send message

Durably admit one session input and schedule agent-loop execution unless resume is false.

Sends a `POST` request to `/api/session/{sessionID}/prompt`

*/
    pub async fn session_prompt<'a>(
        &'a self,
        session_id: &'a types::SessionId,
        body: &'a types::SessionPromptBody,
    ) -> Result<
        ResponseValue<types::SessionPromptResponse>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/api/session/{}/prompt", self.baseurl, encode_path(& session_id
            .to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .post(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "session_prompt",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
    /**Redeem pairing code

Redeem a pairing code. Browsers receive a session cookie and a redirect to the web app; requests that accept JSON receive a session token to use as the password.

Sends a `GET` request to `/auth/connect/{code}`

*/
    pub async fn server_connect<'a>(
        &'a self,
        code: &'a str,
    ) -> Result<
        ResponseValue<types::PairingSession>,
        Error<::serde_json::Map<::std::string::String, ::serde_json::Value>>,
    > {
        let url = format!(
            "{}/auth/connect/{}", self.baseurl, encode_path(& code.to_string()),
        );
        let mut header_map = reqwest013::header::HeaderMap::with_capacity(1usize);
        header_map
            .append(
                reqwest013::header::HeaderName::from_static("api-version"),
                reqwest013::header::HeaderValue::from_static(Self::api_version()),
            );
        #[allow(unused_mut)]
        let mut request = self
            .client
            .get(url)
            .header(
                reqwest013::header::ACCEPT,
                reqwest013::header::HeaderValue::from_static("application/json"),
            )
            .headers(header_map)
            .build()?;
        let info = OperationInfo {
            operation_id: "server_connect",
        };
        self.pre(&mut request, &info).await?;
        let result = self.exec(request, &info).await;
        self.post(&result, &info).await?;
        let response = result?;
        match response.status().as_u16() {
            200u16 => ResponseValue::from_response(response).await,
            400u16..=499u16 => {
                Err(Error::ErrorResponse(ResponseValue::from_response(response).await?))
            }
            _ => Err(Error::UnexpectedResponse(response)),
        }
    }
}
/// Items consumers will typically use such as the Client.
pub mod prelude {
    #[allow(unused_imports)]
    pub use super::Client;
}
