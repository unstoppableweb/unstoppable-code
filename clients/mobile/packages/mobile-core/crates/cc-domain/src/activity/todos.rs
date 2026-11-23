//! `todos.dart` `deviceTodos`: each chat's todos from the scope's tab
//! metadata (complete host-derived metadata, never the phone's paginated
//! transcript tail).
use super::{TodoItem, TodoList};
use crate::dart::{Dv, DvMap};

/// The worktree's chat todos (`DeviceTodos`); two compare equal when
/// Dart's signatures would.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Todos {
    pub lists: Vec<TodoList>,
    /// Chats whose todos this desktop cannot send, in first-seen order.
    pub unavailable: Vec<String>,
}

impl Todos {
    /// `todoUnavailableReason`: `None` when the chat's todos are known,
    /// `Some(false)` while they are loading, `Some(true)` when the desktop
    /// is too old to send them.
    pub fn unavailable_for(this: Option<&Self>, chat: &str) -> Option<bool> {
        let Some(todos) = this else {
            return Some(false);
        };
        let unavailable = todos.unavailable.iter().any(|id| id == chat);
        if !unavailable && !todos.lists.iter().any(|l| l.chat_id == chat) {
            return Some(false);
        }
        unavailable.then_some(true)
    }
}

/// `deviceTodos(tabs)`.
pub fn device_todos(tabs: &[DvMap]) -> Todos {
    fn unavailable(id: &str, todos: &mut Todos) {
        if !todos.unavailable.iter().any(|u| u == id) {
            todos.unavailable.push(id.to_owned());
        }
    }
    let mut todos = Todos::default();
    for tab in tabs {
        let Dv::Str(id) = tab.get("id") else {
            continue;
        };
        if tab.get("kind").is_str("file") || !tab.get("archivedAt").is_null() {
            continue;
        }
        let Dv::Map(descriptor) = tab.get("transcript") else {
            unavailable(id, &mut todos);
            continue;
        };
        let mut items = Vec::new();
        let mut valid = true;
        for field in ["todos", "taskTodos"] {
            let rows = match descriptor.get(field) {
                Dv::Null => Some(Vec::new()),
                other => other.elements(),
            };
            let Some(rows) = rows else {
                valid = false;
                break;
            };
            for row in rows {
                let (Dv::Str(row_id), Dv::Str(content), Dv::Str(status)) =
                    (row.get("id"), row.get("content"), row.get("status"))
                else {
                    valid = false;
                    break;
                };
                if !row.is_map() {
                    valid = false;
                    break;
                }
                items.push(TodoItem {
                    id: format!("{}{row_id}", if field == "todos" { "todo:" } else { "" }),
                    content: content.clone(),
                    status: status.clone(),
                });
            }
        }
        if valid {
            todos.lists.push(TodoList {
                chat_id: id.clone(),
                items,
            });
        } else {
            unavailable(id, &mut todos);
        }
    }
    todos
}
