use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::message::AcpId;

/// One value in an elicitation answer: the shape depends on the field it answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QuestionValue {
    Text(String),
    List(Vec<String>),
    Flag(bool),
}

impl QuestionValue {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text(v) => Value::String(v.clone()),
            Self::List(v) => Value::Array(v.iter().cloned().map(Value::String).collect()),
            Self::Flag(v) => Value::Bool(*v),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionChoice {
    pub value: String,
    pub title: String,
    pub description: String,
}

/// The `<name>_custom` property the adapter adds next to a choice field for free text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionCompanion {
    pub name: String,
    pub title: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FieldKind {
    Single(Vec<QuestionChoice>),
    Multi(Vec<QuestionChoice>),
    Text,
    Boolean,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionField {
    pub name: String,
    pub title: String,
    pub description: String,
    pub kind: FieldKind,
    pub required: bool,
    pub custom: Option<QuestionCompanion>,
}

impl QuestionField {
    pub fn choices(&self) -> &[QuestionChoice] {
        match &self.kind {
            FieldKind::Single(c) | FieldKind::Multi(c) => c,
            FieldKind::Text | FieldKind::Boolean => &[],
        }
    }

    pub fn title_for(&self, value: &str) -> String {
        self.choices()
            .iter()
            .find(|c| c.value == value)
            .map(|c| c.title.clone())
            .unwrap_or_else(|| value.to_string())
    }

    pub fn is_choice(&self) -> bool {
        matches!(self.kind, FieldKind::Single(_) | FieldKind::Multi(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionAction {
    Accept,
    Decline,
    Cancel,
}

impl QuestionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "accept" => Some(Self::Accept),
            "decline" => Some(Self::Decline),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuestionState {
    Pending,
    Answered(BTreeMap<String, QuestionValue>),
    Declined,
    Cancelled,
}

impl QuestionState {
    pub fn from_action(action: QuestionAction, content: BTreeMap<String, QuestionValue>) -> Self {
        match action {
            QuestionAction::Accept => Self::Answered(content),
            QuestionAction::Decline => Self::Declined,
            QuestionAction::Cancel => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    pub request_id: AcpId,
    pub tool_call_id: Option<String>,
    pub message: String,
    pub fields: Vec<QuestionField>,
    pub state: QuestionState,
}

pub const TOOL_NAME: &str = "AskUserQuestion";

impl Question {
    pub fn is_pending(&self) -> bool {
        self.state == QuestionState::Pending
    }

    /// What the host's `acp answers` reports for a request: a choice value, `declined` or `cancelled`.
    pub fn host_state(&self, value: &str) -> QuestionState {
        match value {
            "declined" => QuestionState::Declined,
            "cancelled" => QuestionState::Cancelled,
            _ => {
                let Some(field) = self
                    .fields
                    .iter()
                    .find(|f| f.is_choice())
                    .or(self.fields.first())
                else {
                    return QuestionState::Answered(BTreeMap::new());
                };
                let answer = match field.kind {
                    FieldKind::Multi(_) => QuestionValue::List(vec![value.to_string()]),
                    FieldKind::Boolean => QuestionValue::Flag(value == "true"),
                    FieldKind::Single(_) | FieldKind::Text => {
                        QuestionValue::Text(value.to_string())
                    }
                };
                QuestionState::Answered(BTreeMap::from([(field.name.clone(), answer)]))
            }
        }
    }

    /// "red", or "Vitest · Lint, Types" for several fields; None unless answered.
    pub fn answer_summary(&self) -> Option<String> {
        let QuestionState::Answered(content) = &self.state else {
            return None;
        };
        let mut parts: Vec<String> = Vec::new();
        for field in &self.fields {
            let mut pieces: Vec<String> = Vec::new();
            match content.get(&field.name) {
                Some(QuestionValue::Text(v)) => {
                    if !v.is_empty() {
                        pieces.push(if field.kind == FieldKind::Text {
                            v.clone()
                        } else {
                            field.title_for(v)
                        });
                    }
                }
                Some(QuestionValue::List(vs)) => {
                    pieces.extend(vs.iter().map(|v| field.title_for(v)));
                }
                Some(QuestionValue::Flag(v)) => {
                    pieces.push(if *v { "Yes" } else { "No" }.to_string());
                }
                None => {}
            }
            if let Some(custom) = &field.custom
                && let Some(QuestionValue::Text(v)) = content.get(&custom.name)
                && !v.is_empty()
            {
                pieces.push(v.clone());
            }
            if !pieces.is_empty() {
                parts.push(pieces.join(", "));
            }
        }
        Some(if parts.is_empty() {
            "Answered".to_string()
        } else {
            parts.join(" \u{00B7} ")
        })
    }
}

/// The agent's `elicitation/create` form request, already reduced to what the chat shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElicitationRequest {
    pub tool_call_id: Option<String>,
    pub message: String,
    pub fields: Vec<QuestionField>,
}

const CUSTOM_SUFFIX: &str = "_custom";

/// Natural, case-insensitive order: "question_2" before "question_10".
pub(crate) fn natural_cmp(a: &str, b: &str) -> Ordering {
    let ca: Vec<char> = a.chars().collect();
    let cb: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0, 0);
    while i < ca.len() && j < cb.len() {
        if ca[i].is_ascii_digit() && cb[j].is_ascii_digit() {
            let si = i;
            while i < ca.len() && ca[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < cb.len() && cb[j].is_ascii_digit() {
                j += 1;
            }
            let na: String = ca[si..i].iter().collect::<String>();
            let nb: String = cb[sj..j].iter().collect::<String>();
            let na = na.trim_start_matches('0');
            let nb = nb.trim_start_matches('0');
            let order = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if order != Ordering::Equal {
                return order;
            }
        } else {
            let la: String = ca[i].to_lowercase().collect();
            let lb: String = cb[j].to_lowercase().collect();
            let order = la.cmp(&lb);
            if order != Ordering::Equal {
                return order;
            }
            i += 1;
            j += 1;
        }
    }
    (ca.len() - i).cmp(&(cb.len() - j)).then_with(|| b.cmp(a))
}

pub(crate) fn scalar_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(number_text(n)),
        _ => None,
    }
}

pub(crate) fn number_text(n: &serde_json::Number) -> String {
    if let Some(f) = n.as_f64()
        && !n.is_i64()
        && !n.is_u64()
        && f.fract() == 0.0
        && f.abs() < 1e15
    {
        return format!("{}", f as i64);
    }
    n.to_string()
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Reads a form's `requestedSchema` without ever failing: an unknown property type is a text field.
pub fn schema_fields(schema: &Value) -> Vec<QuestionField> {
    let empty = Map::new();
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let required: HashSet<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut names: Vec<&String> = properties.keys().collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    let mut parsed: Vec<QuestionField> = names
        .into_iter()
        .filter_map(|name| {
            properties
                .get(name)
                .and_then(Value::as_object)
                .map(|p| field(name, p, required.contains(name.as_str())))
        })
        .collect();
    let mut companions: HashMap<String, QuestionField> = HashMap::new();
    for candidate in &parsed {
        if candidate.name.ends_with(CUSTOM_SUFFIX) && candidate.kind == FieldKind::Text {
            let base = &candidate.name[..candidate.name.len() - CUSTOM_SUFFIX.len()];
            if parsed.iter().any(|f| f.name == base && f.is_choice()) {
                companions.insert(base.to_string(), candidate.clone());
            }
        }
    }
    parsed.retain(|f| !companions.values().any(|c| c.name == f.name));
    parsed
        .into_iter()
        .map(|mut f| {
            if let Some(c) = companions.get(&f.name) {
                f.custom = Some(QuestionCompanion {
                    name: c.name.clone(),
                    title: c.title.clone(),
                    hint: c.description.clone(),
                });
            }
            f
        })
        .collect()
}

fn field(name: &str, property: &Map<String, Value>, required: bool) -> QuestionField {
    let kind = match property.get("type").and_then(Value::as_str) {
        Some("boolean") => FieldKind::Boolean,
        Some("array") => {
            let items = property
                .get("items")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let found = choices(&items);
            if found.is_empty() {
                FieldKind::Text
            } else {
                FieldKind::Multi(found)
            }
        }
        _ => {
            let found = choices(property);
            if found.is_empty() {
                FieldKind::Text
            } else {
                FieldKind::Single(found)
            }
        }
    };
    QuestionField {
        name: name.to_string(),
        title: non_empty(property.get("title")).unwrap_or_else(|| name.to_string()),
        description: property
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        kind,
        required,
        custom: None,
    }
}

fn choices(schema: &Map<String, Value>) -> Vec<QuestionChoice> {
    for key in ["oneOf", "anyOf"] {
        let Some(options) = schema.get(key).and_then(Value::as_array) else {
            continue;
        };
        let parsed: Vec<QuestionChoice> = options
            .iter()
            .filter_map(|option| {
                let object = option.as_object()?;
                let value = scalar_text(object.get("const"))?;
                Some(QuestionChoice {
                    title: non_empty(object.get("title")).unwrap_or_else(|| value.clone()),
                    description: object
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    value,
                })
            })
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    let Some(values) = schema.get("enum").and_then(Value::as_array) else {
        return Vec::new();
    };
    let names = schema
        .get("enumNames")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    values
        .iter()
        .enumerate()
        .filter_map(|(index, raw)| {
            let value = scalar_text(Some(raw))?;
            let title = names.get(index).and_then(|n| non_empty(Some(n)));
            Some(QuestionChoice {
                title: title.unwrap_or_else(|| value.clone()),
                value,
                description: String::new(),
            })
        })
        .collect()
}

/// What the user has entered in a question card so far, and the rules for submitting it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuestionDraft {
    /// Chosen values per field, in the order they were picked.
    picked: HashMap<String, Vec<String>>,
    typed: HashMap<String, String>,
    flags: HashMap<String, bool>,
    custom_open: HashSet<String>,
}

impl QuestionDraft {
    pub fn is_picked(&self, field: &QuestionField, value: &str) -> bool {
        self.picked
            .get(&field.name)
            .is_some_and(|v| v.iter().any(|x| x == value))
    }

    pub fn text(&self, name: &str) -> &str {
        self.typed.get(name).map(String::as_str).unwrap_or("")
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.get(name).copied().unwrap_or(false)
    }

    pub fn is_custom_open(&self, name: &str) -> bool {
        self.custom_open.contains(name)
    }

    pub fn choose(&mut self, field: &QuestionField, value: &str) {
        match field.kind {
            FieldKind::Single(_) => {
                self.picked
                    .insert(field.name.clone(), vec![value.to_string()]);
            }
            FieldKind::Multi(_) => {
                let values = self.picked.entry(field.name.clone()).or_default();
                if let Some(i) = values.iter().position(|v| v == value) {
                    values.remove(i);
                } else {
                    values.push(value.to_string());
                }
            }
            FieldKind::Text | FieldKind::Boolean => {}
        }
    }

    pub fn set_text(&mut self, name: &str, value: &str) {
        self.typed.insert(name.to_string(), value.to_string());
    }

    pub fn set_flag(&mut self, name: &str, value: bool) {
        self.flags.insert(name.to_string(), value);
    }

    pub fn open_custom(&mut self, name: &str) {
        self.custom_open.insert(name.to_string());
    }

    fn custom(&self, field: &QuestionField) -> String {
        field
            .custom
            .as_ref()
            .map(|c| self.text(&c.name).trim().to_string())
            .unwrap_or_default()
    }

    /// One question with one single-select field and no free text typed: a tap on an option is the answer.
    pub fn submits_on_tap(&self, fields: &[QuestionField]) -> bool {
        if fields.len() != 1 || !matches!(fields[0].kind, FieldKind::Single(_)) {
            return false;
        }
        self.custom(&fields[0]).is_empty()
    }

    /// The form values an accept sends. Fields left empty are left out.
    pub fn content(&self, fields: &[QuestionField]) -> BTreeMap<String, QuestionValue> {
        let mut content = BTreeMap::new();
        for field in fields {
            match &field.kind {
                FieldKind::Single(_) => {
                    if let Some(v) = self.picked.get(&field.name).and_then(|p| p.first()) {
                        content.insert(field.name.clone(), QuestionValue::Text(v.clone()));
                    }
                }
                FieldKind::Multi(choices) => {
                    let chosen = self.picked.get(&field.name).cloned().unwrap_or_default();
                    let ordered: Vec<String> = choices
                        .iter()
                        .map(|c| c.value.clone())
                        .filter(|v| chosen.contains(v))
                        .collect();
                    if !ordered.is_empty() {
                        content.insert(field.name.clone(), QuestionValue::List(ordered));
                    }
                }
                FieldKind::Text => {
                    let value = self.text(&field.name).trim().to_string();
                    if !value.is_empty() {
                        content.insert(field.name.clone(), QuestionValue::Text(value));
                    }
                }
                FieldKind::Boolean => {
                    content.insert(
                        field.name.clone(),
                        QuestionValue::Flag(self.flag(&field.name)),
                    );
                }
            }
            if let Some(companion) = &field.custom {
                let custom = self.custom(field);
                if !custom.is_empty() {
                    content.insert(companion.name.clone(), QuestionValue::Text(custom));
                }
            }
        }
        content
    }

    /// Every required field has an answer, and something is answered at all: an empty accept
    /// reads to the agent as "did not answer". A boolean always counts as answered.
    pub fn can_submit(&self, fields: &[QuestionField]) -> bool {
        let answers = self.content(fields);
        for field in fields.iter().filter(|f| f.required) {
            let given = answers.contains_key(&field.name)
                || field
                    .custom
                    .as_ref()
                    .is_some_and(|c| answers.contains_key(&c.name));
            if !given {
                return false;
            }
        }
        fields.is_empty() || !answers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn choice(value: &str, title: &str, description: &str) -> Value {
        json!({"const": value, "title": title, "description": description})
    }

    fn plain(value: &str) -> Value {
        choice(value, value, "")
    }

    fn fields_of(properties: Value, required: Option<Value>) -> Vec<QuestionField> {
        let mut schema = json!({"type": "object", "properties": properties});
        if let Some(r) = required {
            schema["required"] = r;
        }
        schema_fields(&schema)
    }

    #[test]
    fn multi_select_accepts_items_one_of_any_of_and_enum() {
        let parsed = fields_of(
            json!({
                "a": {"type": "array", "title": "A", "items": {"oneOf": [choice("x", "X", "the x"), plain("y")]}},
                "b": {"type": "array", "items": {"anyOf": [plain("p"), plain("q")]}},
                "c": {"type": "array", "items": {"enum": ["m", "n"], "enumNames": ["Em", "En"]}},
            }),
            None,
        );
        assert_eq!(
            parsed.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        for f in &parsed {
            assert!(matches!(f.kind, FieldKind::Multi(_)), "{}", f.name);
        }
        assert_eq!(
            parsed[0].choices(),
            [
                QuestionChoice {
                    value: "x".into(),
                    title: "X".into(),
                    description: "the x".into()
                },
                QuestionChoice {
                    value: "y".into(),
                    title: "y".into(),
                    description: String::new()
                },
            ]
        );
        assert_eq!(parsed[1].choices()[1].value, "q");
        assert_eq!(parsed[2].choices()[0].title, "Em");
    }

    #[test]
    fn single_select_accepts_any_of_enum_and_numeric_constants() {
        let parsed = fields_of(
            json!({
                "a": {"type": "string", "anyOf": [plain("x"), plain("y")]},
                "b": {"type": "string", "enum": ["m", "n"]},
                "c": {"type": "integer", "enum": [1, 2]},
            }),
            None,
        );
        for f in &parsed {
            assert!(matches!(f.kind, FieldKind::Single(_)), "{}", f.name);
        }
        assert_eq!(parsed[1].choices()[1].title, "n");
        let values: Vec<_> = parsed[2]
            .choices()
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert_eq!(values, ["1", "2"]);
    }

    #[test]
    fn boolean_unknown_and_empty_choice_fields_and_required() {
        let parsed = fields_of(
            json!({
                "yes": {"type": "boolean", "title": "Run it"},
                "num": {"type": "number", "title": "Count"},
                "odd": {"type": "frobnicate"},
                "empty": {"type": "string", "oneOf": []},
                "arr": {"type": "array", "items": {"type": "string"}},
                "plain": {"type": "string", "description": "free"},
            }),
            Some(json!(["plain", "yes"])),
        );
        let by: HashMap<_, _> = parsed.iter().map(|f| (f.name.as_str(), f)).collect();
        assert_eq!(by["yes"].kind, FieldKind::Boolean);
        assert!(by["yes"].required);
        for name in ["num", "odd", "empty", "arr", "plain"] {
            assert_eq!(by[name].kind, FieldKind::Text, "{name}");
        }
        assert!(by["plain"].required);
        assert_eq!(by["odd"].title, "odd");
    }

    #[test]
    fn fields_keep_numeric_order_and_a_custom_without_a_choice_stays_a_field() {
        let parsed = fields_of(
            json!({
                "question_10": {"type": "string", "oneOf": [plain("a")]},
                "question_2": {"type": "string", "oneOf": [plain("b")]},
                "question_2_custom": {"type": "string", "title": "Other"},
                "note_custom": {"type": "string"},
                "note": {"type": "string"},
            }),
            None,
        );
        let names: Vec<_> = parsed.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["note", "note_custom", "question_2", "question_10"]);
        let q2 = parsed.iter().find(|f| f.name == "question_2").unwrap();
        assert_eq!(q2.custom.as_ref().unwrap().name, "question_2_custom");
        assert!(
            parsed
                .iter()
                .find(|f| f.name == "note")
                .unwrap()
                .custom
                .is_none()
        );
    }

    #[test]
    fn a_malformed_schema_gives_no_fields() {
        for schema in [
            json!({}),
            json!("no"),
            json!({"properties": 3}),
            json!(null),
        ] {
            assert!(schema_fields(&schema).is_empty(), "{schema}");
        }
    }

    #[test]
    fn natural_order_is_case_insensitive_and_numeric() {
        let mut v = vec!["b2", "B10", "a", "b1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["a", "b1", "b2", "B10"]);
    }

    fn q(fields: Vec<QuestionField>, state: QuestionState) -> Question {
        Question {
            request_id: AcpId::Int(5),
            tool_call_id: None,
            message: "Pick".into(),
            fields,
            state,
        }
    }

    #[test]
    fn the_answer_summary_names_choices_lists_and_notes() {
        let fields = fields_of(
            json!({
                "question_0": {"type": "string", "oneOf": [choice("v", "Vitest", "")]},
                "question_1": {"type": "array", "items": {"anyOf": [choice("l", "Lint", ""), choice("t", "Types", "")]}},
                "question_1_custom": {"type": "string"},
                "question_2": {"type": "boolean"},
            }),
            None,
        );
        let mut question = q(fields, QuestionState::Pending);
        question.state = QuestionState::Answered(BTreeMap::from([
            ("question_0".into(), QuestionValue::Text("v".into())),
            (
                "question_1".into(),
                QuestionValue::List(vec!["l".into(), "t".into()]),
            ),
            (
                "question_1_custom".into(),
                QuestionValue::Text("and docs".into()),
            ),
            ("question_2".into(), QuestionValue::Flag(true)),
        ]));
        assert_eq!(
            question.answer_summary().unwrap(),
            "Vitest \u{00B7} Lint, Types, and docs \u{00B7} Yes"
        );
        question.state = QuestionState::Answered(BTreeMap::new());
        assert_eq!(question.answer_summary().unwrap(), "Answered");
        question.state = QuestionState::Declined;
        assert_eq!(question.answer_summary(), None);
    }

    #[test]
    fn host_values_map_to_the_first_choice_field() {
        let fields = fields_of(
            json!({
                "a_note": {"type": "string"},
                "q1": {"type": "array", "items": {"anyOf": [plain("x"), plain("y")]}},
                "q2": {"type": "string", "oneOf": [plain("red")]},
            }),
            None,
        );
        let question = q(fields, QuestionState::Pending);
        assert_eq!(
            question.host_state("x"),
            QuestionState::Answered(BTreeMap::from([(
                "q1".into(),
                QuestionValue::List(vec!["x".into()])
            )]))
        );
        assert_eq!(question.host_state("declined"), QuestionState::Declined);
        assert_eq!(question.host_state("cancelled"), QuestionState::Cancelled);
        assert_eq!(
            q(vec![], QuestionState::Pending).host_state("x"),
            QuestionState::Answered(BTreeMap::new())
        );
    }

    #[test]
    fn values_serialize_as_plain_json() {
        assert_eq!(
            serde_json::to_string(&QuestionValue::List(vec!["a".into()])).unwrap(),
            r#"["a"]"#
        );
        let back: QuestionValue = serde_json::from_str("true").unwrap();
        assert_eq!(back, QuestionValue::Flag(true));
    }

    fn colours() -> QuestionField {
        QuestionField {
            name: "question_0".into(),
            title: "Colour".into(),
            description: String::new(),
            kind: FieldKind::Single(vec![
                QuestionChoice {
                    value: "red".into(),
                    title: "red".into(),
                    description: "Red".into(),
                },
                QuestionChoice {
                    value: "blue".into(),
                    title: "blue".into(),
                    description: "Blue".into(),
                },
            ]),
            required: false,
            custom: Some(QuestionCompanion {
                name: "question_0_custom".into(),
                title: "Other".into(),
                hint: String::new(),
            }),
        }
    }

    fn checks() -> QuestionField {
        let c = |v: &str, t: &str| QuestionChoice {
            value: v.into(),
            title: t.into(),
            description: String::new(),
        };
        QuestionField {
            name: "question_1".into(),
            title: "Checks".into(),
            description: String::new(),
            kind: FieldKind::Multi(vec![
                c("lint", "Lint"),
                c("types", "Types"),
                c("unit", "Unit"),
            ]),
            required: true,
            custom: None,
        }
    }

    fn simple(name: &str, kind: FieldKind, required: bool) -> QuestionField {
        QuestionField {
            name: name.into(),
            title: name.into(),
            description: String::new(),
            kind,
            required,
            custom: None,
        }
    }

    #[test]
    fn single_select_replaces_and_multi_toggles_in_choice_order() {
        let (colours, checks) = (colours(), checks());
        let mut draft = QuestionDraft::default();
        draft.choose(&colours, "red");
        draft.choose(&colours, "blue");
        assert_eq!(
            draft.content(std::slice::from_ref(&colours)),
            BTreeMap::from([("question_0".into(), QuestionValue::Text("blue".into()))])
        );
        for v in ["unit", "lint", "types", "types"] {
            draft.choose(&checks, v);
        }
        assert_eq!(
            draft.content(std::slice::from_ref(&checks)),
            BTreeMap::from([(
                "question_1".into(),
                QuestionValue::List(vec!["lint".into(), "unit".into()])
            )])
        );
    }

    #[test]
    fn a_tap_submits_only_for_a_lone_single_select_without_typed_text() {
        let (colours, checks) = (colours(), checks());
        let mut draft = QuestionDraft::default();
        assert!(draft.submits_on_tap(std::slice::from_ref(&colours)));
        assert!(!draft.submits_on_tap(&[colours.clone(), checks.clone()]));
        assert!(!draft.submits_on_tap(&[checks]));
        draft.open_custom("question_0_custom");
        assert!(draft.submits_on_tap(std::slice::from_ref(&colours)));
        draft.set_text("question_0_custom", "  ");
        assert!(draft.submits_on_tap(std::slice::from_ref(&colours)));
        draft.set_text("question_0_custom", "teal");
        assert!(!draft.submits_on_tap(std::slice::from_ref(&colours)));
    }

    #[test]
    fn custom_text_is_trimmed_and_sent_under_the_companions_name() {
        let colours = colours();
        let mut draft = QuestionDraft::default();
        draft.choose(&colours, "red");
        draft.set_text("question_0_custom", "  but darker \n");
        assert_eq!(
            draft.content(std::slice::from_ref(&colours)),
            BTreeMap::from([
                ("question_0".into(), QuestionValue::Text("red".into())),
                (
                    "question_0_custom".into(),
                    QuestionValue::Text("but darker".into())
                ),
            ])
        );
        let mut only = QuestionDraft::default();
        only.set_text("question_0_custom", "teal");
        assert_eq!(
            only.content(std::slice::from_ref(&colours)),
            BTreeMap::from([(
                "question_0_custom".into(),
                QuestionValue::Text("teal".into())
            )])
        );
        assert!(only.can_submit(std::slice::from_ref(&colours)));
    }

    #[test]
    fn submit_needs_the_required_fields_and_something_answered() {
        let (colours, checks) = (colours(), checks());
        let note = simple("note", FieldKind::Text, true);
        let flag = simple("go", FieldKind::Boolean, false);
        let mut draft = QuestionDraft::default();
        assert!(!draft.can_submit(std::slice::from_ref(&colours)));
        assert!(!draft.can_submit(&[colours.clone(), checks.clone()]));
        draft.choose(&colours, "red");
        assert!(!draft.can_submit(&[colours.clone(), checks.clone()]));
        draft.choose(&checks, "lint");
        assert!(draft.can_submit(&[colours.clone(), checks.clone()]));
        draft.choose(&checks, "lint");
        assert!(!draft.can_submit(&[colours, checks]));
        assert!(!draft.can_submit(std::slice::from_ref(&note)));
        draft.set_text("note", "  ");
        assert!(!draft.can_submit(std::slice::from_ref(&note)));
        draft.set_text("note", "hi");
        assert!(draft.can_submit(std::slice::from_ref(&note)));
        assert!(QuestionDraft::default().can_submit(&[]));
        assert!(QuestionDraft::default().can_submit(std::slice::from_ref(&flag)));
        assert_eq!(
            QuestionDraft::default().content(&[flag]),
            BTreeMap::from([("go".into(), QuestionValue::Flag(false))])
        );
    }
}
