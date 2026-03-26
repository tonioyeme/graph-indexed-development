/**
 * GID Analyze Command
 *
 * Deep code analysis for understanding file structure, patterns, and signatures.
 */

import * as path from 'node:path';
import {
  getFileSignatures,
  detectFilePatterns,
  getFunctionDetails,
  getClassDetails,
  type FileSignatures,
  type DetectedPattern,
  type FunctionDetails,
  type ClassDetails,
} from '../analyzers/code-analysis.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface AnalyzeOptions {
  function?: string;
  class?: string;
  noPatterns?: boolean;
  json?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display Functions
// ═══════════════════════════════════════════════════════════════════════════════

function formatPatterns(patterns: DetectedPattern[]): string {
  if (patterns.length === 0) return '   No patterns detected';

  return patterns
    .map((p) => {
      const confidencePct = Math.round(p.confidence * 100);
      const bar = '█'.repeat(Math.round(p.confidence * 10)) + '░'.repeat(10 - Math.round(p.confidence * 10));
      return `   ${p.pattern.padEnd(20)} ${bar} ${confidencePct}%\n      Indicators: ${p.indicators.join(', ')}`;
    })
    .join('\n');
}

function formatSignatures(signatures: FileSignatures): string {
  const lines: string[] = [];

  // Functions
  if (signatures.functions.length > 0) {
    lines.push(`\n   📦 Functions (${signatures.functions.length}):`);
    for (const fn of signatures.functions) {
      const asyncLabel = fn.async ? 'async ' : '';
      const exportLabel = fn.exported ? 'export ' : '';
      const params = fn.params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(', ');
      const returnType = fn.returnType ? `: ${fn.returnType}` : '';
      lines.push(`      ${exportLabel}${asyncLabel}${fn.name}(${params})${returnType}  [line ${fn.line}]`);
    }
  }

  // Classes
  if (signatures.classes.length > 0) {
    lines.push(`\n   🏛️  Classes (${signatures.classes.length}):`);
    for (const cls of signatures.classes) {
      const exportLabel = cls.exported ? 'export ' : '';
      const extendsLabel = cls.extends ? ` extends ${cls.extends}` : '';
      const implementsLabel = cls.implements?.length ? ` implements ${cls.implements.join(', ')}` : '';
      lines.push(`      ${exportLabel}class ${cls.name}${extendsLabel}${implementsLabel}  [line ${cls.line}]`);

      if (cls.methods.length > 0) {
        lines.push(`         Methods: ${cls.methods.map((m) => m.name).join(', ')}`);
      }
      if (cls.properties.length > 0) {
        lines.push(`         Properties: ${cls.properties.map((p) => p.name).join(', ')}`);
      }
    }
  }

  // Exports
  if (signatures.exports.length > 0) {
    lines.push(`\n   📤 Exports (${signatures.exports.length}):`);
    lines.push(`      ${signatures.exports.join(', ')}`);
  }

  // Imports
  if (signatures.imports.length > 0) {
    lines.push(`\n   📥 Imports (${signatures.imports.length}):`);
    for (const imp of signatures.imports) {
      lines.push(`      ${imp.names.join(', ')} from '${imp.from}'`);
    }
  }

  return lines.join('\n');
}

function formatFunctionDetails(details: FunctionDetails): string {
  const lines: string[] = [];

  lines.push(`\n📦 Function: ${details.signature.name}`);
  lines.push(`   Line: ${details.signature.line}`);
  lines.push(`   Async: ${details.signature.async ? 'Yes' : 'No'}`);
  lines.push(`   Exported: ${details.signature.exported ? 'Yes' : 'No'}`);

  const params = details.signature.params
    .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
    .join(', ');
  lines.push(`   Parameters: (${params})`);

  if (details.signature.returnType) {
    lines.push(`   Returns: ${details.signature.returnType}`);
  }

  lines.push(`\n   📊 Metrics:`);
  lines.push(`      Lines of code: ${details.linesOfCode}`);
  lines.push(`      Complexity: ${details.complexity}`);

  if (details.calls.length > 0) {
    lines.push(`\n   📞 Function calls:`);
    lines.push(`      ${details.calls.join(', ')}`);
  }

  return lines.join('\n');
}

function formatClassDetails(details: ClassDetails): string {
  const lines: string[] = [];
  const { signature } = details;

  lines.push(`\n🏛️  Class: ${signature.name}`);
  lines.push(`   Line: ${signature.line}`);
  lines.push(`   Exported: ${signature.exported ? 'Yes' : 'No'}`);

  if (signature.extends) {
    lines.push(`   Extends: ${signature.extends}`);
  }
  if (signature.implements?.length) {
    lines.push(`   Implements: ${signature.implements.join(', ')}`);
  }

  lines.push(`\n   📊 Metrics:`);
  lines.push(`      Lines of code: ${details.linesOfCode}`);

  if (signature.methods.length > 0) {
    lines.push(`\n   📦 Methods (${signature.methods.length}):`);
    for (const method of signature.methods) {
      const asyncLabel = method.async ? 'async ' : '';
      const params = method.params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(', ');
      lines.push(`      ${asyncLabel}${method.name}(${params})`);
    }
  }

  if (signature.properties.length > 0) {
    lines.push(`\n   🏷️  Properties (${signature.properties.length}):`);
    for (const prop of signature.properties) {
      const visibility = prop.visibility ?? 'public';
      const type = prop.type ? `: ${prop.type}` : '';
      lines.push(`      ${visibility} ${prop.name}${type}`);
    }
  }

  if (details.dependencies.length > 0) {
    lines.push(`\n   📦 Dependencies:`);
    for (const dep of details.dependencies) {
      lines.push(`      ${dep}`);
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════════════════════════════════

export function runAnalyze(filePath: string, options: AnalyzeOptions): void {
  const absolutePath = path.resolve(filePath);

  try {
    // Analyze specific function
    if (options.function) {
      const details = getFunctionDetails(absolutePath, options.function);
      if (!details) {
        console.error(`❌ Function not found: ${options.function}`);
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ type: 'function', ...details }, null, 2));
      } else {
        console.log(formatFunctionDetails(details));
      }
      return;
    }

    // Analyze specific class
    if (options.class) {
      const details = getClassDetails(absolutePath, options.class);
      if (!details) {
        console.error(`❌ Class not found: ${options.class}`);
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ type: 'class', ...details }, null, 2));
      } else {
        console.log(formatClassDetails(details));
      }
      return;
    }

    // Default: full file analysis
    const signatures = getFileSignatures(absolutePath);
    const patterns = options.noPatterns ? [] : detectFilePatterns(absolutePath);

    if (options.json) {
      console.log(JSON.stringify({ type: 'file', signatures, patterns }, null, 2));
      return;
    }

    // Display formatted output
    console.log(`\n📄 ${path.basename(filePath)}`);
    console.log(`   Path: ${absolutePath}`);

    // Patterns
    if (!options.noPatterns && patterns.length > 0) {
      console.log(`\n🏷️  Detected Patterns:`);
      console.log(formatPatterns(patterns));

      // Inferred layer
      const layerInference = inferLayerFromPatterns(patterns, absolutePath);
      if (layerInference) {
        console.log(`\n📐 Inferred Layer: ${layerInference}`);
      }
    }

    // Signatures
    console.log(formatSignatures(signatures));

    // Summary
    console.log(`\n📊 Summary:`);
    console.log(`   Functions: ${signatures.functions.length}`);
    console.log(`   Classes: ${signatures.classes.length}`);
    console.log(`   Exports: ${signatures.exports.length}`);
    console.log(`   Imports: ${signatures.imports.length}`);

  } catch (err) {
    console.error(`❌ Error analyzing file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Helper to infer layer from patterns
function inferLayerFromPatterns(patterns: DetectedPattern[], filePath: string): string | null {
  const pathLower = filePath.toLowerCase();

  // Path-based inference (highest priority)
  if (pathLower.includes('/commands/') || pathLower.includes('/controllers/') || pathLower.includes('/api/')) {
    return 'interface';
  }
  if (pathLower.includes('/services/') || pathLower.includes('/usecases/')) {
    return 'application';
  }
  if (pathLower.includes('/core/') || pathLower.includes('/domain/') || pathLower.includes('/models/')) {
    return 'domain';
  }
  if (pathLower.includes('/extractors/') || pathLower.includes('/repositories/') || pathLower.includes('/infrastructure/')) {
    return 'infrastructure';
  }

  // Pattern-based inference
  for (const { pattern } of patterns) {
    switch (pattern) {
      case 'controller':
      case 'middleware':
      case 'react-component':
        return 'interface';
      case 'service':
        return 'application';
      case 'entity':
      case 'types':
        return 'domain';
      case 'repository':
      case 'config':
        return 'infrastructure';
    }
  }

  return null;
}
