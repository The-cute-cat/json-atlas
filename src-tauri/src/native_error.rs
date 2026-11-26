use serde::Serialize;
use std::{borrow::Cow, fmt};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeError {
    pub(crate) message: Cow<'static, str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_zh_cn: Option<Cow<'static, str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

impl NativeError {
    pub(crate) fn localized(
        message: impl Into<Cow<'static, str>>,
        message_zh_cn: impl Into<Cow<'static, str>>,
    ) -> Self {
        Self {
            message: message.into(),
            message_zh_cn: Some(message_zh_cn.into()),
            code: None,
        }
    }

    pub(crate) fn from_display(error: impl fmt::Display) -> Self {
        error.to_string().into()
    }

    pub(crate) fn file_io(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self {
                code: Some("file_not_found"),
                ..Self::localized("File missing", "文件缺失")
            }
        } else {
            Self::from_display(error)
        }
    }
}

impl From<String> for NativeError {
    fn from(message: String) -> Self {
        Self {
            message: Cow::Owned(message),
            message_zh_cn: None,
            code: None,
        }
    }
}

impl fmt::Display for NativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    #[test]
    fn serializes_english_and_optional_chinese_messages_for_ipc() {
        let error =
            NativeError::localized("Byte 42: invalid JSON value", "字节 42：无效的 JSON 值");
        assert_eq!(error.to_string(), "Byte 42: invalid JSON value");
        assert_eq!(
            to_value(error).unwrap(),
            json!({
                "message": "Byte 42: invalid JSON value",
                "messageZhCn": "字节 42：无效的 JSON 值"
            })
        );
        assert_eq!(
            to_value(NativeError::from_display("Disk failure")).unwrap(),
            json!({"message": "Disk failure"})
        );
        let missing = NativeError::file_io(std::io::ErrorKind::NotFound.into());
        assert_eq!(
            to_value(missing).unwrap(),
            json!({"code": "file_not_found", "message": "File missing", "messageZhCn": "文件缺失"})
        );
    }
}
