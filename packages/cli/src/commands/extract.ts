/**
 * gid extract command
 *
 * Extract dependency graph from existing code.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { loadGraph, saveGraph } from '../core/parser.js';
import { createStateManager, computeFileHashes, getGitCommit, getGitBranch, diffGraphs, ExtractionState } from '../core/state.js';
import { extractTypeScript, groupIntoComponents, ExtractionResult, DEFAULT_IGNORE_DIRS, previewExtraction, PreviewResult } from '../extractors/index.js';
import { createAIClient, detectAIProvider } from '../ai/client.js';
import { getFileSignatures, detectFilePatterns } from '../analyzers/code-analysis.js';
import type { GIDGraph as GIDGraphType } from '../core/types.js';

export interface ExtractOptions {
  lang?: string;
  output?: string;
  group?: boolean;
  force?: boolean;
  tsconfig?: string;
  ignore?: string[];
  include?: string[];
  noDefaultIgnore?: boolean;
  dryRun?: boolean;
  incremental?: boolean;
  interactive?: boolean;
  verify?: boolean;
  depth?: number;
  withStats?: boolean;
  noBarrels?: boolean;
  withSignatures?: boolean;
  withPatterns?: boolean;
  enrich?: boolean;
  withSummaries?: boolean;
  aiProvider?: string;
  aiModel?: string;
}

export async function runExtract(targetDirs: string[], options: ExtractOptions): Promise<void> {
  const {
    lang = 'typescript',
    output,
    group = false,
    force = false,
    tsconfig,
    ignore = [],
    noDefaultIgnore = false,
    dryRun = false,
    incremental = false,
    interactive = false,
    verify = false,
    depth = 0,
    withStats = false,
    noBarrels = false,
    withSignatures = false,
    withPatterns = false,
    enrich = false,
    withSummaries = false,
    aiProvider,
    aiModel,
  } = options;

  // Interactive mode
  if (interactive) {
    await runInteractive(targetDirs, options);
    return;
  }

  // Handle empty dirs (default to current directory)
  const dirs = targetDirs.length > 0 ? targetDirs : ['.'];

  // Resolve all target directories
  const resolvedDirs = dirs.map((d) => path.resolve(d));

  // Verify all directories exist
  for (const dir of resolvedDirs) {
    if (!fs.existsSync(dir)) {
      console.error(chalk.red(`Error: Directory not found: ${dir}`));
      process.exit(1);
    }
  }

  // Check if output already exists (skip for dry-run and incremental)
  const outputPath = output ?? path.join(process.cwd(), '.gid', 'graph.yml');
  if (!dryRun && !force && !incremental && fs.existsSync(outputPath)) {
    console.error(chalk.yellow(`Warning: ${outputPath} already exists.`));
    console.error('Use --force to overwrite, or --incremental to update.');
    process.exit(1);
  }

  // Dry-run mode
  if (dryRun) {
    await runDryRun(resolvedDirs, {
      lang,
      tsconfig,
      ignore,
      noDefaultIgnore,
      outputPath,
    });
    return;
  }

  // Set up state management
  const gidDir = path.dirname(outputPath);
  const stateManager = createStateManager(gidDir);

  // Incremental mode - check for changes
  if (incremental) {
    const previousState = stateManager.loadState();
    if (previousState) {
      console.log();
      console.log(chalk.bold.cyan('Incremental Extraction'));
      console.log(chalk.cyan('═'.repeat(50)));
      console.log();
      console.log(chalk.dim(`Previous extraction: ${previousState.lastExtraction.timestamp}`));
      if (previousState.lastExtraction.gitCommit) {
        console.log(chalk.dim(`Git commit: ${previousState.lastExtraction.gitCommit}`));
      }

      // Quick scan to detect changed files
      const preview = await previewExtraction({
        baseDir: resolvedDirs[0],
        additionalDirs: resolvedDirs.slice(1),
        excludeDir: ignore,
        noDefaultIgnore,
      });

      // Resolve full paths for comparison
      const currentFiles = preview.files.map(f => path.resolve(resolvedDirs[0], f));
      const changes = stateManager.getChangedFiles(currentFiles);

      console.log();
      console.log(chalk.bold('Change Summary:'));
      console.log(`  Added:     ${chalk.green(changes.added.length)} files`);
      console.log(`  Modified:  ${chalk.yellow(changes.modified.length)} files`);
      console.log(`  Deleted:   ${chalk.red(changes.deleted.length)} files`);
      console.log(`  Unchanged: ${chalk.dim(changes.unchanged.length)} files`);

      if (changes.added.length === 0 && changes.modified.length === 0 && changes.deleted.length === 0) {
        console.log();
        console.log(chalk.green('✓ No changes detected. Graph is up to date.'));
        return;
      }

      console.log();
    } else {
      console.log();
      console.log(chalk.yellow('No previous state found. Running full extraction.'));
    }
  }

  console.log();
  console.log(chalk.bold('Extracting dependency graph...'));
  if (resolvedDirs.length === 1) {
    console.log(chalk.dim(`  Source: ${resolvedDirs[0]}`));
  } else {
    console.log(chalk.dim(`  Sources: ${resolvedDirs.length} directories`));
    for (const dir of resolvedDirs) {
      console.log(chalk.dim(`    - ${dir}`));
    }
  }
  console.log(chalk.dim(`  Language: ${lang}`));
  if (ignore.length > 0) {
    console.log(chalk.dim(`  Ignore: ${ignore.join(', ')}`));
  }
  if (noDefaultIgnore) {
    console.log(chalk.dim(`  Default ignores: disabled`));
  }
  if (incremental) {
    console.log(chalk.dim(`  Mode: incremental`));
  }
  console.log();

  try {
    let result: ExtractionResult;

    // Run extraction based on language
    switch (lang.toLowerCase()) {
      case 'typescript':
      case 'ts':
      case 'javascript':
      case 'js':
        result = await extractTypeScript({
          baseDir: resolvedDirs[0],
          additionalDirs: resolvedDirs.slice(1),
          tsConfig: tsconfig,
          excludeDir: ignore,
          noDefaultIgnore,
          verify,
          depth,
          withStats,
          noBarrels,
          withSignatures,
          withPatterns,
          enrich,
        });
        break;

      default:
        console.error(chalk.red(`Unsupported language: ${lang}`));
        console.error('Supported languages: typescript, javascript');
        process.exit(1);
    }

    // Optionally group into components
    let finalGraph = result.graph;
    if (group) {
      console.log(chalk.dim('Grouping files into components...'));
      finalGraph = groupIntoComponents(result.graph);
    }

    // Generate AI summaries if requested
    if (withSummaries) {
      finalGraph = await generateAISummaries(finalGraph, { provider: aiProvider, model: aiModel });
    }

    // Print stats
    printStats(
      result,
      group ? Object.keys(finalGraph.nodes).length : undefined,
      group ? finalGraph.edges.length : undefined
    );

    // Print verification results
    if (result.verification) {
      console.log();
      console.log(chalk.bold('Verification:'));
      console.log(chalk.dim('─'.repeat(40)));
      console.log(`  Source files:    ${result.verification.sourceFiles}`);
      console.log(`  Extracted:       ${result.verification.extractedFiles}`);
      console.log(`  Coverage:        ${result.verification.coverage}%`);

      if (result.verification.missingFiles.length > 0) {
        console.log();
        console.log(chalk.yellow(`  Missing files (${result.verification.missingFiles.length}):`));
        for (const file of result.verification.missingFiles.slice(0, 5)) {
          console.log(chalk.yellow(`    - ${file}`));
        }
        if (result.verification.missingFiles.length > 5) {
          console.log(chalk.dim(`    ... and ${result.verification.missingFiles.length - 5} more`));
        }
      }
    }

    // Print warnings
    if (result.warnings.length > 0) {
      console.log();
      console.log(chalk.yellow('Warnings:'));
      for (const warning of result.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning}`));
      }
    }

    // Print circular dependencies
    if (result.stats.circularDeps.length > 0) {
      console.log();
      console.log(chalk.yellow(`Circular dependencies found (${result.stats.circularDeps.length}):`));
      for (const cycle of result.stats.circularDeps.slice(0, 5)) {
        console.log(chalk.yellow(`  → ${cycle.join(' → ')}`));
      }
      if (result.stats.circularDeps.length > 5) {
        console.log(chalk.dim(`  ... and ${result.stats.circularDeps.length - 5} more`));
      }
    }

    // Save current graph to history before overwriting (if it exists)
    if (fs.existsSync(outputPath)) {
      try {
        const previousGraph = loadGraph(outputPath);
        stateManager.saveHistory(previousGraph);
        console.log(chalk.dim('Previous graph saved to history.'));
      } catch {
        // Ignore errors loading previous graph
      }
    }

    // Save graph
    const savedPath = saveGraph(finalGraph, outputPath);

    // Save extraction state for incremental mode
    const preview = await previewExtraction({
      baseDir: resolvedDirs[0],
      additionalDirs: resolvedDirs.slice(1),
      excludeDir: ignore,
      noDefaultIgnore,
    });
    const currentFiles = preview.files.map(f => path.resolve(resolvedDirs[0], f));

    const newState: ExtractionState = {
      lastExtraction: {
        timestamp: new Date().toISOString(),
        gitCommit: getGitCommit(resolvedDirs[0]),
        gitBranch: getGitBranch(resolvedDirs[0]),
      },
      fileHashes: computeFileHashes(currentFiles),
      config: {
        directories: resolvedDirs,
        extensions: ['ts', 'tsx', 'js', 'jsx'],
        excludeDirs: ignore,
      },
    };
    stateManager.saveState(newState);

    console.log();
    console.log(chalk.green('✓ Graph extracted successfully'));
    console.log(`  ${chalk.cyan(savedPath)}`);
    console.log();
    console.log('Next steps:');
    console.log('  1. Review and edit the generated graph');
    console.log('  2. Add Features and implements edges');
    console.log('  3. Run `gid check` to validate');
    console.log('  4. Run `gid query impact <node>` to analyze');
  } catch (err) {
    console.error();
    console.error(chalk.red(`Extraction failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Run dry-run mode - preview what would be extracted
 */
async function runDryRun(
  resolvedDirs: string[],
  options: {
    lang: string;
    tsconfig?: string;
    ignore: string[];
    noDefaultIgnore: boolean;
    outputPath: string;
  }
): Promise<void> {
  console.log();
  console.log(chalk.bold.cyan('Dry Run - No files will be modified'));
  console.log(chalk.cyan('═'.repeat(50)));
  console.log();

  try {
    let preview: PreviewResult;

    // Get preview based on language
    switch (options.lang.toLowerCase()) {
      case 'typescript':
      case 'ts':
      case 'javascript':
      case 'js':
        preview = await previewExtraction({
          baseDir: resolvedDirs[0],
          additionalDirs: resolvedDirs.slice(1),
          tsConfig: options.tsconfig,
          excludeDir: options.ignore,
          noDefaultIgnore: options.noDefaultIgnore,
        });
        break;

      default:
        console.error(chalk.red(`Unsupported language: ${options.lang}`));
        process.exit(1);
    }

    // Print directories to scan
    console.log(chalk.bold('Directories to scan:'));
    for (const dir of preview.directories) {
      console.log(chalk.green(`  ✓ ${dir}`));
    }
    console.log();

    // Print excluded directories found
    if (preview.excludedDirsFound.length > 0) {
      console.log(chalk.bold('Excluded directories (found):'));
      for (const dir of preview.excludedDirsFound) {
        console.log(chalk.dim(`  ⊘ ${dir}`));
      }
      console.log();
    }

    // Print files to process
    console.log(chalk.bold(`Files to process: ${preview.files.length}`));
    const maxFilesToShow = 15;
    for (const file of preview.files.slice(0, maxFilesToShow)) {
      console.log(chalk.dim(`  ${file}`));
    }
    if (preview.files.length > maxFilesToShow) {
      console.log(chalk.dim(`  ... and ${preview.files.length - maxFilesToShow} more`));
    }
    console.log();

    // Print estimates
    console.log(chalk.bold('Estimates:'));
    console.log(`  Nodes: ${preview.files.length}`);
    console.log(`  Edges: ~${Math.round(preview.files.length * 2.5)} (estimated)`);
    console.log();

    // Print output path
    console.log(chalk.bold('Output:'));
    const outputExists = fs.existsSync(options.outputPath);
    if (outputExists) {
      console.log(chalk.yellow(`  ${options.outputPath} (will be overwritten)`));
    } else {
      console.log(`  ${options.outputPath}`);
    }
    console.log();

    // Print next step
    console.log(chalk.dim('Run without --dry-run to execute extraction.'));

  } catch (err) {
    console.error();
    console.error(chalk.red(`Preview failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * List default ignore directories
 */
export function listDefaultIgnores(): void {
  console.log();
  console.log(chalk.bold('Default ignored directories:'));
  console.log();
  for (const dir of DEFAULT_IGNORE_DIRS) {
    console.log(`  ${dir}`);
  }
  console.log();
  console.log(chalk.dim('Use --no-default-ignore to disable these defaults.'));
  console.log(chalk.dim('Use --ignore to add additional patterns.'));
}

function printStats(
  result: ExtractionResult,
  groupedCount?: number,
  groupedEdges?: number
): void {
  console.log(chalk.bold('Extraction Results:'));
  console.log(chalk.dim('─'.repeat(40)));
  console.log(`  Files scanned:      ${result.stats.filesScanned}`);

  if (groupedCount !== undefined) {
    console.log(`  Components created: ${groupedCount}`);
    console.log(chalk.dim(`  (grouped from ${result.stats.componentsFound} files)`));
  } else {
    console.log(`  Nodes created:      ${result.stats.componentsFound}`);
  }

  if (groupedEdges !== undefined) {
    console.log(`  Dependencies found: ${groupedEdges}`);
    console.log(chalk.dim(`  (grouped from ${result.stats.dependenciesFound} file-level imports)`));
  } else {
    console.log(`  Dependencies found: ${result.stats.dependenciesFound}`);
  }

  if (result.stats.enrichedNodes) {
    console.log(`  Nodes enriched:     ${chalk.cyan(result.stats.enrichedNodes)}`);
  }

  if (result.stats.circularDeps.length > 0) {
    console.log(`  Circular deps:      ${chalk.yellow(result.stats.circularDeps.length)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Interactive Mode
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple prompt helper using readline
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Yes/No prompt with default value
 */
async function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(`${question} ${hint} `);

  if (answer === '') {
    return defaultYes;
  }

  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * Interactive extraction flow
 */
async function runInteractive(targetDirs: string[], options: ExtractOptions): Promise<void> {
  const {
    lang = 'typescript',
    output,
    group = false,
    tsconfig,
    ignore = [],
    noDefaultIgnore = false,
  } = options;

  console.log();
  console.log(chalk.bold.cyan('GID Interactive Extraction'));
  console.log(chalk.cyan('═'.repeat(50)));
  console.log();

  // Step 1: Determine directories to scan
  let dirs = targetDirs.length > 0 ? targetDirs : ['.'];
  const resolvedDirs = dirs.map((d) => path.resolve(d));

  console.log(chalk.bold('Scanning directory...'));
  console.log();

  // Verify directories exist
  for (const dir of resolvedDirs) {
    if (!fs.existsSync(dir)) {
      console.error(chalk.red(`Error: Directory not found: ${dir}`));
      process.exit(1);
    }
  }

  // Step 2: Preview and detect excluded directories
  let preview: PreviewResult;
  try {
    preview = await previewExtraction({
      baseDir: resolvedDirs[0],
      additionalDirs: resolvedDirs.slice(1),
      excludeDir: ignore,
      noDefaultIgnore,
    });
  } catch (err) {
    console.error(chalk.red(`Error scanning directory: ${(err as Error).message}`));
    process.exit(1);
  }

  // Show detected build directories
  if (preview.excludedDirsFound.length > 0) {
    console.log(chalk.yellow('⚠ Detected build/output directories:'));
    for (const dir of preview.excludedDirsFound) {
      const desc = getBuildDirDescription(dir);
      console.log(chalk.yellow(`  • ${dir}${desc ? ` (${desc})` : ''}`));
    }
    console.log();

    const excludeConfirm = await confirm('Exclude these directories?');
    if (excludeConfirm) {
      console.log(chalk.green(`✓ Excluded: ${preview.excludedDirsFound.join(', ')}`));
    } else {
      // Re-run preview without default ignores
      preview = await previewExtraction({
        baseDir: resolvedDirs[0],
        additionalDirs: resolvedDirs.slice(1),
        excludeDir: ignore,
        noDefaultIgnore: true,
      });
      console.log(chalk.dim('Default exclusions disabled.'));
    }
    console.log();
  }

  // Step 3: Show files found
  console.log(chalk.bold(`Found ${preview.files.length} source files:`));

  // Group by directory
  const dirCounts = new Map<string, number>();
  for (const file of preview.files) {
    const dir = path.dirname(file).split('/')[0] || '.';
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }

  for (const [dir, count] of dirCounts) {
    console.log(`  • ${dir}/ (${count} files)`);
  }
  console.log();

  // Step 4: Confirm extraction
  const proceedConfirm = await confirm('Continue with extraction?');
  if (!proceedConfirm) {
    console.log();
    console.log(chalk.yellow('Extraction cancelled.'));
    return;
  }

  console.log();
  console.log(chalk.dim('Extracting dependencies...'));

  // Step 5: Run extraction
  try {
    let result: ExtractionResult;

    switch (lang.toLowerCase()) {
      case 'typescript':
      case 'ts':
      case 'javascript':
      case 'js':
        result = await extractTypeScript({
          baseDir: resolvedDirs[0],
          additionalDirs: resolvedDirs.slice(1),
          tsConfig: tsconfig,
          excludeDir: ignore,
          noDefaultIgnore,
        });
        break;

      default:
        console.error(chalk.red(`Unsupported language: ${lang}`));
        process.exit(1);
    }

    // Optionally group into components
    let finalGraph = result.graph;
    if (group) {
      finalGraph = groupIntoComponents(result.graph);
    }

    // Print results
    console.log();
    console.log(chalk.green(`✓ ${result.stats.filesScanned} nodes created`));
    console.log(chalk.green(`✓ ${result.stats.dependenciesFound} edges found`));

    if (result.stats.circularDeps.length > 0) {
      console.log(chalk.yellow(`⚠ ${result.stats.circularDeps.length} circular dependencies detected`));
    }

    // Print warnings
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(chalk.yellow(`⚠ ${warning}`));
      }
    }

    console.log();

    // Step 6: Confirm save
    const outputPath = output ?? path.join(process.cwd(), '.gid', 'graph.yml');
    const outputExists = fs.existsSync(outputPath);

    let saveMessage = `Save graph to ${outputPath}?`;
    if (outputExists) {
      saveMessage = `Overwrite ${outputPath}?`;
    }

    const saveConfirm = await confirm(saveMessage);
    if (!saveConfirm) {
      console.log();
      console.log(chalk.yellow('Graph not saved. You can re-run extraction when ready.'));
      return;
    }

    // Set up state management
    const gidDir = path.dirname(outputPath);
    const stateManager = createStateManager(gidDir);

    // Save to history if exists
    if (outputExists) {
      try {
        const previousGraph = loadGraph(outputPath);
        stateManager.saveHistory(previousGraph);
      } catch {
        // Ignore
      }
    }

    // Save graph
    const savedPath = saveGraph(finalGraph, outputPath);

    // Save extraction state
    const currentFiles = preview.files.map(f => path.resolve(resolvedDirs[0], f));
    const newState: ExtractionState = {
      lastExtraction: {
        timestamp: new Date().toISOString(),
        gitCommit: getGitCommit(resolvedDirs[0]),
        gitBranch: getGitBranch(resolvedDirs[0]),
      },
      fileHashes: computeFileHashes(currentFiles),
      config: {
        directories: resolvedDirs,
        extensions: ['ts', 'tsx', 'js', 'jsx'],
        excludeDirs: ignore,
      },
    };
    stateManager.saveState(newState);

    console.log();
    console.log(chalk.green('✓ Graph saved successfully'));
    console.log(chalk.dim(`  ${savedPath}`));
    console.log();
    console.log(chalk.bold('Next steps:'));
    console.log('  1. Review the generated graph: `gid serve`');
    console.log('  2. Validate with: `gid check`');
    console.log('  3. Query impact: `gid query impact <node>`');

  } catch (err) {
    console.error();
    console.error(chalk.red(`Extraction failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Get description for common build directories
 */
function getBuildDirDescription(dir: string): string {
  const descriptions: Record<string, string> = {
    '.next': 'Next.js build output',
    '.nuxt': 'Nuxt.js build output',
    'dist': 'Build artifacts',
    'build': 'Build artifacts',
    'out': 'Build output',
    'node_modules': 'Dependencies',
    '.git': 'Git repository',
    'coverage': 'Test coverage',
    '.turbo': 'Turborepo cache',
    '.vercel': 'Vercel deployment',
    '.cache': 'Cache directory',
    '.vite': 'Vite cache',
    '.svelte-kit': 'SvelteKit output',
    '.angular': 'Angular cache',
    '__pycache__': 'Python cache',
    'vendor': 'Vendor dependencies',
    '.bundle': 'Bundle cache',
  };

  return descriptions[dir] || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI Summary Generation (Pro CLI Feature)
// ═══════════════════════════════════════════════════════════════════════════════

interface AISummaryOptions {
  provider?: string;
  model?: string;
}

/**
 * Generate AI-powered descriptions for graph nodes
 */
async function generateAISummaries(
  graph: GIDGraphType,
  options: AISummaryOptions
): Promise<GIDGraphType> {
  // Detect AI provider
  const provider = options.provider || detectAIProvider();
  if (!provider) {
    console.log(chalk.yellow('\n⚠ No AI provider configured for --with-summaries.'));
    console.log(chalk.dim('  Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.'));
    console.log(chalk.dim('  Skipping AI summary generation.'));
    return graph;
  }

  console.log();
  console.log(chalk.dim(`Generating AI summaries using ${provider}...`));

  try {
    const client = createAIClient({
      provider: provider as 'openai' | 'anthropic' | 'ollama',
      model: options.model,
    });

    // Get File nodes that need summaries
    const fileNodes = Object.entries(graph.nodes).filter(
      ([_, node]) => node.type === 'File' && node.path && !node.description
    );

    if (fileNodes.length === 0) {
      console.log(chalk.dim('  No files need summaries.'));
      return graph;
    }

    console.log(chalk.dim(`  Processing ${fileNodes.length} files...`));

    let processed = 0;
    let failed = 0;

    for (const [nodeId, node] of fileNodes) {
      if (!node.path) continue;

      try {
        // Get file analysis
        const signatures = getFileSignatures(node.path);
        const patterns = detectFilePatterns(node.path);

        // Build context for AI
        const context = buildFileContext(node.path, signatures, patterns);

        // Generate summary
        const summary = await client.complete(
          `Based on the following file analysis, provide a concise one-sentence description of what this file does and its role in the codebase. Only respond with the description, no explanation.

${context}`,
          {
            maxTokens: 100,
            temperature: 0.3,
          }
        );

        // Clean up and assign
        const cleanSummary = summary.trim().replace(/^["']|["']$/g, '');
        if (cleanSummary && cleanSummary.length > 10) {
          node.description = cleanSummary;
          processed++;
        }

        // Progress indicator
        if ((processed + failed) % 10 === 0) {
          process.stdout.write(chalk.dim('.'));
        }
      } catch {
        failed++;
      }
    }

    console.log();
    console.log(chalk.dim(`  Generated ${processed} summaries (${failed} failed).`));

    return graph;
  } catch (err) {
    console.log(chalk.yellow(`\n⚠ AI summary generation failed: ${(err as Error).message}`));
    console.log(chalk.dim('  Continuing without AI summaries.'));
    return graph;
  }
}

/**
 * Build context string for AI to generate summary
 */
function buildFileContext(
  filePath: string,
  signatures: ReturnType<typeof getFileSignatures>,
  patterns: ReturnType<typeof detectFilePatterns>
): string {
  const lines: string[] = [];

  lines.push(`File: ${path.basename(filePath)}`);
  lines.push(`Path: ${filePath}`);

  if (patterns.length > 0) {
    lines.push(`Patterns: ${patterns.map(p => p.pattern).join(', ')}`);
  }

  if (signatures.classes.length > 0) {
    lines.push(`Classes: ${signatures.classes.map(c => c.name).join(', ')}`);
  }

  if (signatures.functions.length > 0) {
    const exportedFns = signatures.functions.filter(f => f.exported);
    if (exportedFns.length > 0) {
      lines.push(`Exported functions: ${exportedFns.map(f => f.name).join(', ')}`);
    }
  }

  if (signatures.exports.length > 0) {
    lines.push(`Exports: ${signatures.exports.slice(0, 10).join(', ')}${signatures.exports.length > 10 ? '...' : ''}`);
  }

  if (signatures.imports.length > 0) {
    const importSources = [...new Set(signatures.imports.map(i => i.from))].slice(0, 5);
    lines.push(`Key imports: ${importSources.join(', ')}`);
  }

  return lines.join('\n');
}
