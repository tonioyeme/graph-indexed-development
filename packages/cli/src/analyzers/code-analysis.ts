/**
 * Code Analysis Tools for GID MCP
 *
 * Provides deep code inspection for semantic graph building.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FunctionSignature {
  name: string;
  params: Array<{ name: string; type?: string }>;
  returnType?: string;
  async: boolean;
  exported: boolean;
  line: number;
}

export interface ClassSignature {
  name: string;
  extends?: string;
  implements?: string[];
  exported: boolean;
  methods: FunctionSignature[];
  properties: Array<{ name: string; type?: string; visibility?: string }>;
  line: number;
}

export interface FileSignatures {
  path: string;
  functions: FunctionSignature[];
  classes: ClassSignature[];
  exports: string[];
  imports: Array<{ from: string; names: string[] }>;
}

export interface DetectedPattern {
  pattern: string;
  confidence: number;
  indicators: string[];
}

export interface FileSummaryInput {
  path: string;
  signatures: FileSignatures;
  patterns: DetectedPattern[];
  content?: string;
}

export interface FunctionDetails {
  signature: FunctionSignature;
  body: string;
  calls: string[];
  complexity: number;
  linesOfCode: number;
}

export interface ClassDetails {
  signature: ClassSignature;
  body: string;
  dependencies: string[];
  linesOfCode: number;
}

export interface CodeSearchResult {
  file: string;
  line: number;
  column: number;
  match: string;
  context: string;
}

/**
 * Extract function and class signatures from a TypeScript/JavaScript file.
 */
export function getFileSignatures(filePath: string): FileSignatures {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lines = content.split('\n');

  const functions: FunctionSignature[] = [];
  const classes: ClassSignature[] = [];
  const exports: string[] = [];
  const imports: Array<{ from: string; names: string[] }> = [];

  // Parse imports
  const importRegex = /import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  let importMatch;
  while ((importMatch = importRegex.exec(content)) !== null) {
    const names = importMatch[1]
      ? importMatch[1].split(',').map(n => n.trim().split(' as ')[0])
      : [importMatch[2]];
    imports.push({ from: importMatch[3], names: names.filter(Boolean) });
  }

  // Parse functions
  const funcRegex = /^(\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/gm;
  let funcMatch;
  while ((funcMatch = funcRegex.exec(content)) !== null) {
    const line = content.slice(0, funcMatch.index).split('\n').length;
    const params = parseParams(funcMatch[5]);

    functions.push({
      name: funcMatch[4],
      params,
      returnType: funcMatch[6]?.trim(),
      async: !!funcMatch[3],
      exported: !!funcMatch[2],
      line,
    });

    if (funcMatch[2]) {
      exports.push(funcMatch[4]);
    }
  }

  // Parse arrow functions with export
  const arrowRegex = /^(\s*)(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*(?::\s*([^\s=]+))?\s*=>/gm;
  let arrowMatch;
  while ((arrowMatch = arrowRegex.exec(content)) !== null) {
    const line = content.slice(0, arrowMatch.index).split('\n').length;
    const paramsStart = content.indexOf('(', arrowMatch.index) + 1;
    const paramsEnd = content.indexOf(')', paramsStart);
    const paramsStr = content.slice(paramsStart, paramsEnd);

    functions.push({
      name: arrowMatch[4],
      params: parseParams(paramsStr),
      returnType: arrowMatch[6]?.trim(),
      async: !!arrowMatch[5],
      exported: !!arrowMatch[2],
      line,
    });

    if (arrowMatch[2]) {
      exports.push(arrowMatch[4]);
    }
  }

  // Parse classes
  const classRegex = /^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/gm;
  let classMatch;
  while ((classMatch = classRegex.exec(content)) !== null) {
    const classLine = content.slice(0, classMatch.index).split('\n').length;
    const className = classMatch[4];

    // Find class body
    const classStart = content.indexOf('{', classMatch.index);
    const classEnd = findMatchingBrace(content, classStart);
    const classBody = content.slice(classStart + 1, classEnd);

    const methods: FunctionSignature[] = [];
    const properties: Array<{ name: string; type?: string; visibility?: string }> = [];

    // Parse methods
    const methodRegex = /(public|private|protected)?\s*(async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/g;
    let methodMatch;
    while ((methodMatch = methodRegex.exec(classBody)) !== null) {
      if (['constructor', 'if', 'for', 'while', 'switch'].includes(methodMatch[3])) continue;

      const methodLine = classLine + classBody.slice(0, methodMatch.index).split('\n').length;
      methods.push({
        name: methodMatch[3],
        params: parseParams(methodMatch[4]),
        returnType: methodMatch[5]?.trim(),
        async: !!methodMatch[2],
        exported: false,
        line: methodLine,
      });
    }

    // Parse properties
    const propRegex = /(public|private|protected)?\s*(readonly\s+)?(\w+)(?:\s*:\s*([^;=]+))?/g;
    let propMatch;
    const propMatches = classBody.match(propRegex) || [];
    for (const prop of propMatches) {
      const parts = prop.match(/(public|private|protected)?\s*(readonly\s+)?(\w+)(?:\s*:\s*(.+))?/);
      if (parts && !['constructor', 'async', 'return', 'const', 'let', 'var'].includes(parts[3])) {
        properties.push({
          name: parts[3],
          type: parts[4]?.trim(),
          visibility: parts[1] || 'public',
        });
      }
    }

    classes.push({
      name: className,
      extends: classMatch[5],
      implements: classMatch[6]?.split(',').map(s => s.trim()),
      exported: !!classMatch[2],
      methods,
      properties,
      line: classLine,
    });

    if (classMatch[2]) {
      exports.push(className);
    }
  }

  // Parse export statements
  const namedExportRegex = /export\s+{\s*([^}]+)\s*}/g;
  let namedExportMatch;
  while ((namedExportMatch = namedExportRegex.exec(content)) !== null) {
    const names = namedExportMatch[1].split(',').map(n => n.trim().split(' as ')[0]);
    exports.push(...names);
  }

  return {
    path: absolutePath,
    functions,
    classes,
    exports: [...new Set(exports)],
    imports,
  };
}

/**
 * Detect architectural patterns in a file.
 *
 * IMPORTANT: Pattern detection is based on:
 * 1. Filename patterns (most reliable)
 * 2. Directory path patterns (reliable)
 * 3. Import statements (reliable)
 * 4. Decorator/annotation usage at statement level (not string matching)
 *
 * We deliberately avoid content.includes() for pattern keywords
 * as it causes false positives when code references those patterns
 * in comments or string literals.
 */
export function detectFilePatterns(filePath: string): DetectedPattern[] {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const fileName = path.basename(filePath).toLowerCase();
  const dirPath = path.dirname(absolutePath).toLowerCase();
  const patterns: DetectedPattern[] = [];

  // Parse imports for framework detection
  const imports = parseImports(content);
  const importSources = imports.map(i => i.from.toLowerCase());
  const importNames = imports.flatMap(i => i.names.map(n => n.toLowerCase()));

  // ═══════════════════════════════════════════════════════════════════════════
  // Controller pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based (high confidence)
    if (fileName.includes('controller')) {
      indicators.push('filename contains "controller"');
    }

    // Directory-based (high confidence)
    if (dirPath.includes('/controllers/') || dirPath.includes('/controller/') || dirPath.endsWith('/controllers')) {
      indicators.push('in controllers directory');
    }

    // Import-based (high confidence) - NestJS, Express Router
    if (importSources.some(s => s.includes('@nestjs/common'))) {
      // Check for actual @Controller decorator at statement level
      if (hasDecoratorAtStatementLevel(content, 'Controller')) {
        indicators.push('uses @Controller decorator (NestJS)');
      }
    }

    // Express router pattern (check for Router import + route definitions)
    if (importNames.includes('router') || content.match(/express\.Router\(\)/)) {
      if (hasRouteDefinitions(content)) {
        indicators.push('defines Express routes');
      }
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'controller',
        confidence: indicators.length >= 2 ? 0.95 : indicators[0].includes('filename') || indicators[0].includes('directory') ? 0.9 : 0.7,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Service pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('service') && !fileName.includes('.test.') && !fileName.includes('.spec.')) {
      indicators.push('filename contains "service"');
    }

    // Directory-based
    if (dirPath.includes('/services/') || dirPath.includes('/service/') || dirPath.endsWith('/services')) {
      indicators.push('in services directory');
    }

    // Import-based - NestJS Injectable
    if (importSources.some(s => s.includes('@nestjs/common'))) {
      if (hasDecoratorAtStatementLevel(content, 'Injectable')) {
        indicators.push('uses @Injectable decorator (NestJS)');
      }
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'service',
        confidence: indicators.length >= 2 ? 0.95 : 0.85,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Repository pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('repository') || fileName.includes('repo.')) {
      indicators.push('filename contains "repository/repo"');
    }

    // Directory-based
    if (dirPath.includes('/repositories/') || dirPath.includes('/repository/') || dirPath.endsWith('/repositories')) {
      indicators.push('in repositories directory');
    }

    // Import-based - TypeORM, Prisma, Sequelize
    if (importSources.some(s => s.includes('typeorm'))) {
      if (hasDecoratorAtStatementLevel(content, 'Repository') || hasDecoratorAtStatementLevel(content, 'EntityRepository')) {
        indicators.push('uses TypeORM repository');
      }
    }
    if (importSources.some(s => s.includes('@prisma/client'))) {
      indicators.push('uses Prisma client');
    }
    if (importSources.some(s => s.includes('sequelize'))) {
      indicators.push('uses Sequelize ORM');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'repository',
        confidence: indicators.length >= 2 ? 0.95 : 0.85,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Model/Entity pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('model') || fileName.includes('entity') || fileName.includes('.dto.')) {
      indicators.push('filename indicates model/entity/dto');
    }

    // Directory-based
    if (dirPath.includes('/models/') || dirPath.includes('/entities/') || dirPath.includes('/dto/') || dirPath.endsWith('/models')) {
      indicators.push('in models/entities directory');
    }

    // Import-based - TypeORM, Sequelize decorators
    if (importSources.some(s => s.includes('typeorm'))) {
      if (hasDecoratorAtStatementLevel(content, 'Entity') || hasDecoratorAtStatementLevel(content, 'Column')) {
        indicators.push('uses TypeORM entity decorators');
      }
    }
    if (importSources.some(s => s.includes('sequelize'))) {
      if (hasDecoratorAtStatementLevel(content, 'Table') || hasDecoratorAtStatementLevel(content, 'Model')) {
        indicators.push('uses Sequelize model decorators');
      }
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'entity',
        confidence: indicators.length >= 2 ? 0.95 : 0.85,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Middleware pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('middleware')) {
      indicators.push('filename contains "middleware"');
    }

    // Directory-based
    if (dirPath.includes('/middleware/') || dirPath.includes('/middlewares/') || dirPath.endsWith('/middleware')) {
      indicators.push('in middleware directory');
    }

    // Export signature pattern: (req, res, next) => or function(req, res, next)
    if (hasMiddlewareSignature(content)) {
      indicators.push('exports middleware signature (req, res, next)');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'middleware',
        confidence: indicators.length >= 2 ? 0.9 : 0.8,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Hook pattern (React/Vue hooks)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based - use*.ts pattern for React hooks
    if (fileName.match(/^use[A-Z]/) || fileName.includes('.hook.')) {
      indicators.push('filename follows hook naming convention');
    }

    // Directory-based
    if (dirPath.includes('/hooks/') || dirPath.endsWith('/hooks')) {
      indicators.push('in hooks directory');
    }

    // Import-based - React with hook exports
    if (importSources.some(s => s === 'react' || s === "'react'" || s === '"react"')) {
      // Check if file exports a function starting with "use"
      if (exportsHookFunction(content)) {
        indicators.push('exports React hook function');
      }
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'hook',
        confidence: indicators.length >= 2 ? 0.95 : 0.8,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // React Component pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // File extension (tsx/jsx strongly indicates React component)
    if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) {
      indicators.push('JSX file extension');
    }

    // Directory-based
    if (dirPath.includes('/components/') || dirPath.endsWith('/components')) {
      indicators.push('in components directory');
    }

    // Import-based - React import with JSX return
    const hasReactImport = importSources.some(s => s === 'react' || s === "'react'" || s === '"react"');
    if (hasReactImport && hasJSXReturn(content)) {
      indicators.push('React component with JSX return');
    }

    // PascalCase filename (React component convention) + tsx
    if (fileName.match(/^[A-Z]/) && (fileName.endsWith('.tsx') || fileName.endsWith('.jsx'))) {
      indicators.push('PascalCase filename (component convention)');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'react-component',
        confidence: indicators.length >= 2 ? 0.95 : 0.8,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Test pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based (most reliable)
    if (fileName.includes('.test.') || fileName.includes('.spec.') || fileName.includes('_test.')) {
      indicators.push('test file naming pattern');
    }

    // Directory-based
    if (dirPath.includes('/__tests__/') || dirPath.includes('/test/') || dirPath.includes('/tests/')) {
      indicators.push('in test directory');
    }

    // Import-based - test frameworks
    if (importSources.some(s => s.includes('vitest') || s.includes('jest') || s.includes('@testing-library') || s.includes('mocha'))) {
      indicators.push('imports test framework');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'test',
        confidence: 0.98, // Tests are very reliably detected
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Config pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('config') || fileName.includes('.conf') ||
        fileName === 'settings.ts' || fileName === 'settings.js' ||
        fileName.match(/^\..*rc\.?(js|ts|json)?$/)) {
      indicators.push('config file naming pattern');
    }

    // Well-known config files
    if (['tsconfig.json', 'package.json', 'jest.config.js', 'vite.config.ts', 'webpack.config.js', 'eslint.config.js'].some(c => fileName.includes(c))) {
      indicators.push('well-known config file');
    }

    // Directory-based
    if (dirPath.includes('/config/') || dirPath.endsWith('/config')) {
      indicators.push('in config directory');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'config',
        confidence: indicators.length >= 2 ? 0.95 : 0.85,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utility/Helper pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('util') || fileName.includes('helper') || fileName.includes('helpers')) {
      indicators.push('filename indicates utility/helper');
    }

    // Directory-based
    if (dirPath.includes('/utils/') || dirPath.includes('/util/') || dirPath.includes('/helpers/') ||
        dirPath.includes('/lib/') || dirPath.endsWith('/utils') || dirPath.endsWith('/lib')) {
      indicators.push('in utils/lib directory');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'utility',
        confidence: indicators.length >= 2 ? 0.9 : 0.75,
        indicators,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Types/Interfaces pattern
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const indicators: string[] = [];

    // Filename-based
    if (fileName.includes('.types.') || fileName.includes('.d.ts') || fileName === 'types.ts' || fileName === 'interfaces.ts') {
      indicators.push('type definition file naming');
    }

    // Directory-based
    if (dirPath.includes('/types/') || dirPath.includes('/@types/') || dirPath.endsWith('/types')) {
      indicators.push('in types directory');
    }

    if (indicators.length > 0) {
      patterns.push({
        pattern: 'types',
        confidence: 0.95,
        indicators,
      });
    }
  }

  return patterns;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern Detection Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse import statements from content
 */
function parseImports(content: string): Array<{ from: string; names: string[] }> {
  const imports: Array<{ from: string; names: string[] }> = [];
  const importRegex = /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const names = match[1]
      ? match[1].split(',').map(n => n.trim().split(' as ')[0].trim())
      : match[2] ? [match[2]] : match[3] ? [match[3]] : [];
    imports.push({ from: match[4], names: names.filter(Boolean) });
  }

  return imports;
}

/**
 * Check if a decorator is used at statement level (not in strings/comments)
 */
function hasDecoratorAtStatementLevel(content: string, decoratorName: string): boolean {
  // Match @DecoratorName at start of line (possibly with whitespace) or after another decorator
  const pattern = new RegExp(`^\\s*@${decoratorName}\\s*\\(`, 'm');
  return pattern.test(content);
}

/**
 * Check if file has Express route definitions
 */
function hasRouteDefinitions(content: string): boolean {
  // Match router.get/post/put/delete at statement level
  return /^\s*(router|app)\.(get|post|put|delete|patch)\s*\(/m.test(content);
}

/**
 * Check if file has middleware signature export
 */
function hasMiddlewareSignature(content: string): boolean {
  // Match export of function with (req, res, next) or (request, response, next) signature
  return /export\s+(default\s+)?(?:function|const|async\s+function)\s*\w*\s*\([^)]*(?:req|request)[^)]*,\s*(?:res|response)[^)]*,\s*next/i.test(content);
}

/**
 * Check if file exports a React hook function (use* naming)
 */
function exportsHookFunction(content: string): boolean {
  // Match export of function starting with "use"
  return /export\s+(?:default\s+)?(?:function|const)\s+use[A-Z]\w*/.test(content);
}

/**
 * Check if file has JSX return statement
 */
function hasJSXReturn(content: string): boolean {
  // Match return ( with JSX-like content
  return /return\s*\(\s*</.test(content) || /return\s+</.test(content);
}

/**
 * Prepare file summary input for AI-generated description.
 * Returns structured data for AI to generate summary.
 */
export function prepareFileSummary(filePath: string, includeContent: boolean = false): FileSummaryInput {
  const signatures = getFileSignatures(filePath);
  const patterns = detectFilePatterns(filePath);

  return {
    path: filePath,
    signatures,
    patterns,
    content: includeContent ? fs.readFileSync(filePath, 'utf-8') : undefined,
  };
}

/**
 * Get detailed information about a specific function.
 */
export function getFunctionDetails(filePath: string, functionName: string): FunctionDetails | null {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');

  // Find function definition - search for the function name with context
  let funcStart = -1;
  let isArrowFunc = false;

  // Try regular function: function name( or async function name(
  const funcPattern = new RegExp(`(export\\s+)?(async\\s+)?function\\s+${functionName}\\s*\\(`, 'g');
  const funcMatch = funcPattern.exec(content);
  if (funcMatch) {
    funcStart = funcMatch.index;
  }

  // Try arrow function: const/let name = or name =
  if (funcStart === -1) {
    const arrowPattern = new RegExp(`(export\\s+)?(const|let|var)\\s+${functionName}\\s*=`, 'g');
    const arrowMatch = arrowPattern.exec(content);
    if (arrowMatch) {
      // Verify it's actually a function (has => after params)
      const afterEquals = content.slice(arrowMatch.index + arrowMatch[0].length, arrowMatch.index + arrowMatch[0].length + 500);
      if (afterEquals.includes('=>')) {
        funcStart = arrowMatch.index;
        isArrowFunc = true;
      }
    }
  }

  // Try method in object/class: name( or name: function(
  if (funcStart === -1) {
    const methodPattern = new RegExp(`\\b${functionName}\\s*[:(]`, 'g');
    let methodMatch;
    while ((methodMatch = methodPattern.exec(content)) !== null) {
      // Check context - should be after { or , (object/class member)
      const before = content.slice(Math.max(0, methodMatch.index - 50), methodMatch.index);
      if (/[{,]\s*$/.test(before) || /^\s*(public|private|protected|async)?\s*$/.test(before.split('\n').pop() || '')) {
        funcStart = methodMatch.index;
        break;
      }
    }
  }

  if (funcStart === -1) {
    return null;
  }

  // Find the function body
  let body: string;
  let bodyStart: number;
  let bodyEnd: number;

  if (isArrowFunc) {
    // For arrow functions, find the => and then the body
    const arrowIndex = content.indexOf('=>', funcStart);
    if (arrowIndex === -1) return null;

    const afterArrow = content.slice(arrowIndex + 2).trimStart();
    const absoluteAfterArrow = arrowIndex + 2 + (content.slice(arrowIndex + 2).length - afterArrow.length);

    if (afterArrow.startsWith('{')) {
      // Block body
      bodyStart = content.indexOf('{', arrowIndex);
      bodyEnd = findMatchingBrace(content, bodyStart);
      body = content.slice(funcStart, bodyEnd + 1);
    } else {
      // Expression body - find end by looking for statement terminator
      bodyStart = absoluteAfterArrow;
      bodyEnd = findExpressionEnd(content, bodyStart);
      body = content.slice(funcStart, bodyEnd);
    }
  } else {
    // Regular function - find opening brace
    bodyStart = content.indexOf('{', funcStart);
    if (bodyStart === -1) return null;
    bodyEnd = findMatchingBrace(content, bodyStart);
    body = content.slice(funcStart, bodyEnd + 1);
  }

  // Extract calls
  const callRegex = /(\w+)\s*\(/g;
  const calls: string[] = [];
  let callMatch;
  while ((callMatch = callRegex.exec(body)) !== null) {
    if (!['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'throw', 'new', 'typeof', 'instanceof'].includes(callMatch[1])) {
      calls.push(callMatch[1]);
    }
  }

  // Get signature
  const signatures = getFileSignatures(filePath);
  const signature = signatures.functions.find(f => f.name === functionName);

  if (!signature) {
    // Create a basic signature if not found in getFileSignatures
    const asyncMatch = body.match(/^(export\s+)?(async\s+)/);
    return {
      signature: {
        name: functionName,
        params: [],
        async: !!asyncMatch?.[2],
        exported: !!asyncMatch?.[1],
        line: content.slice(0, funcStart).split('\n').length,
      },
      body,
      calls: [...new Set(calls)],
      complexity: calculateComplexity(body),
      linesOfCode: body.split('\n').length,
    };
  }

  return {
    signature,
    body,
    calls: [...new Set(calls)],
    complexity: calculateComplexity(body),
    linesOfCode: body.split('\n').length,
  };
}

function calculateComplexity(body: string): number {
  const complexityKeywords = ['if', 'else', 'for', 'while', 'case', 'catch'];
  const complexityOperators = ['&&', '||', '?'];
  let complexity = 1;

  for (const keyword of complexityKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'g');
    const matches = body.match(regex);
    if (matches) complexity += matches.length;
  }

  for (const op of complexityOperators) {
    const escaped = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    const matches = body.match(regex);
    if (matches) complexity += matches.length;
  }

  return complexity;
}

function findExpressionEnd(content: string, start: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = start; i < content.length; i++) {
    const char = content[i];
    const prevChar = i > 0 ? content[i - 1] : '';

    // Handle string literals
    if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (inString) continue;

    // Track bracket depth
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;

    // End of expression: semicolon, newline at depth 0, or closing brace/paren at negative depth
    if (depth === 0 && (char === ';' || char === '\n')) {
      return i;
    }
    if (depth < 0) {
      return i;
    }
  }

  return content.length;
}

/**
 * Get detailed information about a specific class.
 */
export function getClassDetails(filePath: string, className: string): ClassDetails | null {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');

  // Find class definition
  const classRegex = new RegExp(
    `(export\\s+)?(abstract\\s+)?class\\s+${className}[^{]*\\{`,
    'g'
  );

  const match = classRegex.exec(content);

  if (!match) {
    return null;
  }

  // Extract class body
  const startIndex = content.indexOf('{', match.index);
  const endIndex = findMatchingBrace(content, startIndex);
  const body = content.slice(match.index, endIndex + 1);

  // Get signature
  const signatures = getFileSignatures(filePath);
  const signature = signatures.classes.find(c => c.name === className);

  if (!signature) {
    return null;
  }

  // Extract dependencies from imports used in class
  const dependencies: string[] = [];
  for (const imp of signatures.imports) {
    for (const name of imp.names) {
      if (body.includes(name)) {
        dependencies.push(`${name} from ${imp.from}`);
      }
    }
  }

  return {
    signature,
    body,
    dependencies,
    linesOfCode: body.split('\n').length,
  };
}

/**
 * Search for a code pattern across files.
 */
export function searchCodePattern(
  directory: string,
  pattern: string,
  options: {
    extensions?: string[];
    maxResults?: number;
    contextLines?: number;
  } = {}
): CodeSearchResult[] {
  const {
    extensions = ['ts', 'tsx', 'js', 'jsx'],
    maxResults = 50,
    contextLines = 2,
  } = options;

  const results: CodeSearchResult[] = [];
  const regex = new RegExp(pattern, 'gi');

  function searchDir(dir: string): void {
    if (results.length >= maxResults) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) {
            searchDir(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1);
          if (extensions.includes(ext)) {
            searchFile(fullPath, regex, results, contextLines, maxResults);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  searchDir(path.resolve(directory));
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function parseParams(paramsStr: string): Array<{ name: string; type?: string }> {
  if (!paramsStr.trim()) return [];

  const params: Array<{ name: string; type?: string }> = [];
  const parts = paramsStr.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Handle destructuring
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      params.push({ name: trimmed.split(':')[0].trim() });
      continue;
    }

    const [nameWithOptional, type] = trimmed.split(':').map(s => s.trim());
    const name = nameWithOptional.replace('?', '');

    params.push({ name, type });
  }

  return params;
}

function findMatchingBrace(content: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];
    const prevChar = i > 0 ? content[i - 1] : '';

    // Handle string literals
    if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (inString) continue;

    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return content.length;
}

function searchFile(
  filePath: string,
  regex: RegExp,
  results: CodeSearchResult[],
  contextLines: number,
  maxResults: number
): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      const line = lines[i];
      let match;

      regex.lastIndex = 0;
      while ((match = regex.exec(line)) !== null && results.length < maxResults) {
        const startLine = Math.max(0, i - contextLines);
        const endLine = Math.min(lines.length - 1, i + contextLines);
        const context = lines.slice(startLine, endLine + 1).join('\n');

        results.push({
          file: filePath,
          line: i + 1,
          column: match.index + 1,
          match: match[0],
          context,
        });
      }
    }
  } catch {
    // Ignore read errors
  }
}

function functions(content: string): number {
  const funcMatches = content.match(/function\s+\w+/g) || [];
  const arrowMatches = content.match(/const\s+\w+\s*=\s*\(/g) || [];
  return funcMatches.length + arrowMatches.length;
}

function classes(content: string): number {
  const classMatches = content.match(/class\s+\w+/g) || [];
  return classMatches.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Enrichment - Combine signatures, patterns, and layer inference
// ═══════════════════════════════════════════════════════════════════════════════

export interface EnrichmentResult {
  signatures: FileSignatures;
  patterns: DetectedPattern[];
  suggestedLayer?: 'interface' | 'application' | 'domain' | 'infrastructure';
  suggestedType?: 'File' | 'Component';
}

/**
 * Enrich a file with signatures, patterns, and suggested type/layer.
 * This combines getFileSignatures + detectFilePatterns + layer inference.
 */
export function enrichFile(filePath: string): EnrichmentResult {
  const signatures = getFileSignatures(filePath);
  const patterns = detectFilePatterns(filePath);

  // Infer layer from path
  const suggestedLayer = inferLayerFromPath(filePath);

  // Suggest Component type if we have strong patterns
  const suggestedType = shouldUpgradeToComponent(patterns, signatures) ? 'Component' : 'File';

  return {
    signatures,
    patterns,
    suggestedLayer,
    suggestedType,
  };
}

/**
 * Infer architectural layer from file path.
 */
function inferLayerFromPath(filePath: string): 'interface' | 'application' | 'domain' | 'infrastructure' | undefined {
  const pathLower = filePath.toLowerCase();

  // Interface layer - entry points, APIs, UI
  if (pathLower.includes('/commands/') || pathLower.includes('/cmd/') ||
      pathLower.includes('/api/') || pathLower.includes('/routes/') ||
      pathLower.includes('/controllers/') || pathLower.includes('/web/') ||
      pathLower.includes('/pages/') || pathLower.includes('/views/') ||
      pathLower.includes('/components/') || pathLower.includes('/handlers/')) {
    return 'interface';
  }

  // Application layer - business logic, services, use cases
  if (pathLower.includes('/services/') || pathLower.includes('/usecases/') ||
      pathLower.includes('/use-cases/') || pathLower.includes('/application/') ||
      pathLower.includes('/analyzers/') || pathLower.includes('/ai/')) {
    return 'application';
  }

  // Domain layer - core business logic, types, entities
  if (pathLower.includes('/core/') || pathLower.includes('/lib/') ||
      pathLower.includes('/domain/') || pathLower.includes('/entities/') ||
      pathLower.includes('/types/') || pathLower.includes('/models/') ||
      pathLower.includes('/schemas/')) {
    return 'domain';
  }

  // Infrastructure layer - external dependencies, data access
  if (pathLower.includes('/extractors/') || pathLower.includes('/parsers/') ||
      pathLower.includes('/infrastructure/') || pathLower.includes('/db/') ||
      pathLower.includes('/repositories/') || pathLower.includes('/database/') ||
      pathLower.includes('/adapters/') || pathLower.includes('/clients/')) {
    return 'infrastructure';
  }

  return undefined;
}

/**
 * Determine if a file should be upgraded from File to Component.
 * Returns true if we have high-confidence patterns indicating it's a component.
 */
function shouldUpgradeToComponent(patterns: DetectedPattern[], signatures: FileSignatures): boolean {
  // If we have patterns with high confidence, upgrade to Component
  const highConfidencePatterns = patterns.filter(p => p.confidence >= 0.8);
  if (highConfidencePatterns.length > 0) {
    // Exclude test and config files from Component upgrade
    const nonTestPatterns = highConfidencePatterns.filter(
      p => p.pattern !== 'test' && p.pattern !== 'config' && p.pattern !== 'types'
    );
    if (nonTestPatterns.length > 0) {
      return true;
    }
  }

  // If file has classes or multiple exported functions, it's likely a component
  if (signatures.classes.length > 0) {
    return true;
  }

  // Multiple exported functions suggest a module/component
  const exportedFunctions = signatures.functions.filter(f => f.exported);
  if (exportedFunctions.length >= 2) {
    return true;
  }

  return false;
}
