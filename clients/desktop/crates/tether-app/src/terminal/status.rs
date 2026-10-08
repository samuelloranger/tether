#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnStatus {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lamp {
    Warning,
    Success,
    Danger,
}

impl ConnStatus {
    pub fn word(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn lamp(self) -> Lamp {
        match self {
            Self::Connecting | Self::Reconnecting => Lamp::Warning,
            Self::Connected => Lamp::Success,
            Self::Disconnected => Lamp::Danger,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_lamps_follow_the_ios_connection_lamp() {
        assert_eq!(ConnStatus::Connecting.word(), "connecting");
        assert_eq!(ConnStatus::Reconnecting.lamp(), Lamp::Warning);
        assert_eq!(ConnStatus::Connected.lamp(), Lamp::Success);
        assert_eq!(ConnStatus::Disconnected.lamp(), Lamp::Danger);
    }
}
