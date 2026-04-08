/// Convert arbitrary text to a URL/ID-friendly slug.
///
/// Rules:
/// - Lowercase all characters
/// - Replace non-alphanumeric characters with dashes
/// - Strip non-ASCII characters
/// - Collapse consecutive dashes into one
/// - Strip leading and trailing dashes
/// - Return "unnamed" for empty results
pub fn slugify(text: &str) -> String {
    let result: String = text
        .chars()
        .filter(|c| c.is_ascii())
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();

    // Collapse consecutive dashes
    let mut collapsed = String::with_capacity(result.len());
    let mut prev_dash = false;
    for c in result.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }

    // Strip leading and trailing dashes
    let trimmed = collapsed.trim_matches('-');

    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hello_world() {
        assert_eq!(slugify("Hello World"), "hello-world");
    }

    #[test]
    fn test_multiple_spaces() {
        assert_eq!(slugify("  Multiple   Spaces  "), "multiple-spaces");
    }

    #[test]
    fn test_camel_case_underscore() {
        assert_eq!(slugify("CamelCase_Test"), "camelcase-test");
    }

    #[test]
    fn test_leading_trailing_dashes() {
        assert_eq!(slugify("---leading-trailing---"), "leading-trailing");
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(slugify(""), "unnamed");
    }

    #[test]
    fn test_only_spaces() {
        assert_eq!(slugify("   "), "unnamed");
    }

    #[test]
    fn test_non_ascii_stripped() {
        assert_eq!(slugify("café résumé"), "caf-rsum");
    }

    #[test]
    fn test_colon_in_text() {
        assert_eq!(slugify("feat: add login"), "feat-add-login");
    }

    #[test]
    fn test_single_char() {
        assert_eq!(slugify("a"), "a");
    }

    #[test]
    fn test_consecutive_dashes_in_input() {
        assert_eq!(slugify("hello---world"), "hello-world");
    }
}
