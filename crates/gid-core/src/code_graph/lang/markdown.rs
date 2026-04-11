//! Markdown document structure parser for doc-aware code graph extraction.
//!
//! Extracts heading hierarchy from .md files to create doc/section nodes.
//! No tree-sitter needed — markdown headings are trivially line-parseable.

use super::super::types::*;

/// Result of parsing a markdown file.
pub struct MarkdownParseResult {
    pub nodes: Vec<CodeNode>,
    pub edges: Vec<CodeEdge>,
    /// GOAL/GUARD identifiers found in the document (e.g., "GOAL-1", "GUARD-3")
    pub requirement_ids: Vec<(String, usize)>,
    /// Key terms extracted from headings (for doc→code linking)
    pub heading_terms: Vec<String>,
}

/// Parse a markdown file into doc + section nodes.
pub fn parse_markdown(rel_path: &str, content: &str) -> MarkdownParseResult {
    let filename = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let doc_kind = DocKind::from_filename(filename);

    // Extract title from first H1 or filename
    let title = extract_title(content, filename);

    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut requirement_ids = Vec::new();
    let mut heading_terms = Vec::new();

    // Create the doc node
    let doc_node = CodeNode::new_doc(rel_path, &title, doc_kind);
    let doc_id = doc_node.id.clone();
    nodes.push(doc_node);

    // Parse headings to create section nodes
    let mut section_stack: Vec<(usize, String)> = Vec::new(); // (level, section_id)

    let mut in_code_block = false;
    for (line_idx, line) in content.lines().enumerate() {
        let line_num = line_idx + 1;
        let trimmed = line.trim();

        // Track code blocks (skip headings inside ```)
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        // Parse ATX headings (# style)
        if let Some(heading) = parse_atx_heading(trimmed) {
            let section_node = CodeNode::new_section(rel_path, &heading.text, heading.level, line_num);
            let section_id = section_node.id.clone();
            nodes.push(section_node);

            // Add heading terms for linking
            heading_terms.push(heading.text.clone());

            // Build hierarchy: section → parent section (or doc)
            // Pop sections from stack that are same level or deeper
            while section_stack.last().map_or(false, |(lvl, _)| *lvl >= heading.level) {
                section_stack.pop();
            }

            let parent_id = section_stack.last()
                .map(|(_, id)| id.clone())
                .unwrap_or_else(|| doc_id.clone());

            edges.push(CodeEdge::new(&section_id, &parent_id, EdgeRelation::DefinedIn));

            section_stack.push((heading.level, section_id));
        }

        // Scan for GOAL-N / GUARD-N patterns
        scan_requirement_ids(trimmed, line_num, &mut requirement_ids);
    }

    // Set line_count on doc node
    if let Some(doc) = nodes.first_mut() {
        doc.line_count = content.lines().count();
    }

    MarkdownParseResult {
        nodes,
        edges,
        requirement_ids,
        heading_terms,
    }
}

struct Heading {
    level: usize,
    text: String,
}

fn parse_atx_heading(line: &str) -> Option<Heading> {
    if !line.starts_with('#') {
        return None;
    }
    let level = line.chars().take_while(|&c| c == '#').count();
    if level > 6 || level == 0 {
        return None;
    }
    let text = line[level..].trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(Heading { level, text })
}

fn extract_title(content: &str, filename: &str) -> String {
    // Look for first H1
    for line in content.lines().take(10) {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") && !trimmed.starts_with("##") {
            return trimmed[2..].trim().to_string();
        }
    }
    // Fallback: filename without extension
    filename.trim_end_matches(".md").trim_end_matches(".markdown").to_string()
}

fn scan_requirement_ids(line: &str, line_num: usize, ids: &mut Vec<(String, usize)>) {
    let patterns = ["GOAL-", "GUARD-", "REQ-"];
    for pattern in &patterns {
        let mut search_from = 0;
        while let Some(pos) = line[search_from..].find(pattern) {
            let start = search_from + pos;
            let rest = &line[start + pattern.len()..];
            let id_chars: String = rest.chars()
                .take_while(|c| c.is_alphanumeric() || *c == '.' || *c == '-')
                .collect();
            if !id_chars.is_empty() {
                ids.push((format!("{}{}", pattern, id_chars), line_num));
            }
            search_from = start + pattern.len();
        }
    }
}
