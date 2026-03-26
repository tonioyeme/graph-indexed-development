#!/usr/bin/env node

/**
 * GID CLI - Graph-Indexed Development
 *
 * Query and manage dependency graphs for software projects.
 */

import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runImpactQuery, runDepsQuery, runCommonCauseQuery, runPathQuery } from './commands/query.js';
import { runExtract, listDefaultIgnores } from './commands/extract.js';
import { runDesign } from './commands/design.js';
import { runHistoryList, runHistoryDiff, runHistoryRestore } from './commands/history.js';
import { runVisual } from './commands/visual.js';
import { runSemantify } from './commands/semantify.js';
import { runAdvise } from './commands/advise.js';
import { runAnalyze } from './commands/analyze.js';
import { runRefactor } from './commands/refactor.js';

const program = new Command();

program
  .name('gid')
  .description('Graph-Indexed Development CLI - Query and manage dependency graphs')
  .version('0.1.0');

// ═══════════════════════════════════════════════════════════════════════════════
// init command
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('init')
  .description('Initialize a new graph.yml in the current project')
  .option('-f, --force', 'Overwrite existing graph.yml')
  .action((options) => {
    runInit({ force: options.force });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// query command
// ═══════════════════════════════════════════════════════════════════════════════

const queryCommand = program
  .command('query')
  .description('Query the dependency graph');

// query impact
queryCommand
  .command('impact <node>')
  .description('Analyze what is affected by changing a node')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .action((node, options) => {
    runImpactQuery(node, options.graph);
  });

// query deps
queryCommand
  .command('deps <node>')
  .description('Show dependencies of a node (what it depends on)')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .option('-r, --reverse', 'Show dependents instead (what depends on it)')
  .action((node, options) => {
    runDepsQuery(node, { reverse: options.reverse, graphPath: options.graph });
  });

// query common-cause
queryCommand
  .command('common-cause <nodeA> <nodeB>')
  .description('Find common dependencies of two nodes (useful for debugging)')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .action((nodeA, nodeB, options) => {
    runCommonCauseQuery(nodeA, nodeB, options.graph);
  });

// query path
queryCommand
  .command('path <from> <to>')
  .description('Find dependency path between two nodes')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .action((from, to, options) => {
    runPathQuery(from, to, options.graph);
  });

// ═══════════════════════════════════════════════════════════════════════════════
// extract command
// ═══════════════════════════════════════════════════════════════════════════════

const extractCommand = program
  .command('extract [directories...]')
  .description('Extract dependency graph from existing code')
  .option('-l, --lang <language>', 'Source language (typescript, javascript)', 'typescript')
  .option('-o, --output <file>', 'Output file path')
  .option('-g, --group', 'Group files into components by directory')
  .option('-f, --force', 'Overwrite existing graph')
  .option('--tsconfig <file>', 'Path to tsconfig.json')
  .option('-i, --ignore <patterns...>', 'Additional patterns/directories to ignore')
  .option('--no-default-ignore', 'Disable default ignore patterns (.next, dist, etc.)')
  .option('-n, --dry-run', 'Preview what would be extracted without making changes')
  .option('--incremental', 'Only process changed files (faster for large projects)')
  .option('--interactive', 'Interactive guided extraction')
  .option('--verify', 'Verify extraction completeness (report missing files)')
  .option('--depth <n>', 'Limit dependency depth (0 = unlimited)', parseInt)
  .option('--with-stats', 'Include file stats (loc, exports) in nodes')
  .option('--no-barrels', 'Exclude barrel/index files that only re-export')
  .option('--with-signatures', 'Include function/class signature counts in nodes')
  .option('--with-patterns', 'Detect and include architectural patterns (controller, service, etc.)')
  .option('--enrich', 'Shorthand for --with-stats --with-signatures --with-patterns')
  .option('--with-summaries', 'Generate AI descriptions for files (Pro CLI)')
  .option('--ai-provider <provider>', 'AI provider for summaries (openai, anthropic, ollama)')
  .option('--ai-model <model>', 'AI model to use for summaries')
  .action((directories, options) => {
    runExtract(directories || ['.'], {
      lang: options.lang,
      output: options.output,
      group: options.group,
      force: options.force,
      tsconfig: options.tsconfig,
      ignore: options.ignore,
      noDefaultIgnore: !options.defaultIgnore,
      dryRun: options.dryRun,
      incremental: options.incremental,
      interactive: options.interactive,
      verify: options.verify,
      depth: options.depth,
      withStats: options.withStats,
      noBarrels: !options.barrels,
      withSignatures: options.withSignatures,
      withPatterns: options.withPatterns,
      enrich: options.enrich,
      withSummaries: options.withSummaries,
      aiProvider: options.aiProvider,
      aiModel: options.aiModel,
    });
  });

// extract ignore-list subcommand
extractCommand
  .command('ignore-list')
  .description('List default ignored directories')
  .action(() => {
    listDefaultIgnores();
  });

// ═══════════════════════════════════════════════════════════════════════════════
// design command
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('design')
  .description('AI-assisted top-down graph design')
  .option('-p, --provider <provider>', 'AI provider (openai, anthropic, ollama)')
  .option('-m, --model <model>', 'AI model to use')
  .option('-o, --output <file>', 'Output file path')
  .option('-f, --force', 'Overwrite existing graph')
  .option('--non-interactive', 'Run without interactive prompts')
  .option('-r, --requirements <text>', 'Requirements text (for non-interactive mode)')
  .action((options) => {
    runDesign({
      provider: options.provider,
      model: options.model,
      output: options.output,
      force: options.force,
      nonInteractive: options.nonInteractive,
      requirements: options.requirements,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// visual command
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('visual')
  .description('Interactive graph visualization')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .option('-p, --port <port>', 'Server port (default: 3000)', parseInt)
  .option('--no-open', 'Do not open browser automatically')
  .option('-s, --static', 'Generate static HTML file (no server)')
  .action((options) => {
    runVisual({
      graphPath: options.graph,
      port: options.port,
      noOpen: !options.open,
      static: options.static,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// semantify command (Pro CLI)
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('semantify')
  .description('Upgrade file-level graph to semantic graph with layers, components, and features')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .option('-s, --scope <scope>', 'What to semantify: layers, components, features, all (default: all)')
  .option('-n, --dry-run', 'Preview proposals without applying changes')
  .option('-y, --yes', 'Auto-approve all changes (for CI)')
  .option('--json', 'Output proposals as JSON')
  .option('--ai', 'Use AI for true semantic understanding (reads docs + code)')
  .option('--ai-provider <provider>', 'AI provider (openai, anthropic, ollama)')
  .option('--ai-model <model>', 'AI model to use')
  .action((options) => {
    runSemantify({
      graphPath: options.graph,
      scope: options.scope,
      dryRun: options.dryRun,
      yes: options.yes,
      json: options.json,
      ai: options.ai,
      aiProvider: options.aiProvider,
      aiModel: options.aiModel,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// advise command (Pro CLI)
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('advise')
  .description('Analyze graph and suggest improvements')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .option('-l, --level <level>', 'Analysis level: deterministic, heuristic, all (default: all)')
  .option('-c, --include-context', 'Include code pattern context for suggestions')
  .option('--json', 'Output suggestions as JSON')
  .action((options) => {
    runAdvise({
      graphPath: options.graph,
      level: options.level,
      includeContext: options.includeContext,
      json: options.json,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// analyze command (Pro CLI)
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('analyze <file>')
  .description('Analyze file structure, patterns, and signatures')
  .option('-f, --function <name>', 'Deep dive into a specific function')
  .option('-c, --class <name>', 'Deep dive into a specific class')
  .option('--no-patterns', 'Skip pattern detection')
  .option('--json', 'Output as JSON')
  .action((file, options) => {
    runAnalyze(file, {
      function: options.function,
      class: options.class,
      noPatterns: !options.patterns,
      json: options.json,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// refactor command (Pro CLI)
// ═══════════════════════════════════════════════════════════════════════════════

program
  .command('refactor <operation> <nodeId>')
  .description('Preview or apply graph changes (operations: preview, rename, move, delete)')
  .option('-g, --graph <path>', 'Path to graph.yml file')
  .option('-n, --new-name <name>', 'New name for rename operation')
  .option('-l, --new-layer <layer>', 'New layer for move operation (interface, application, domain, infrastructure)')
  .option('--no-dry-run', 'Apply changes (default is dry-run/preview)')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--json', 'Output as JSON')
  .action((operation, nodeId, options) => {
    runRefactor(operation, nodeId, {
      graphPath: options.graph,
      newName: options.newName,
      newLayer: options.newLayer,
      dryRun: options.dryRun,
      yes: options.yes,
      json: options.json,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// history command
// ═══════════════════════════════════════════════════════════════════════════════

const historyCommand = program
  .command('history')
  .description('Manage graph version history');

// history list
historyCommand
  .command('list')
  .description('List available graph versions')
  .action(() => {
    runHistoryList();
  });

// history diff
historyCommand
  .command('diff <version>')
  .description('Compare a historical version to current graph')
  .action((version) => {
    runHistoryDiff(version);
  });

// history restore
historyCommand
  .command('restore <version>')
  .description('Restore a historical version')
  .option('-f, --force', 'Overwrite current graph without confirmation')
  .action((version, options) => {
    runHistoryRestore(version, { force: options.force });
  });

// ═══════════════════════════════════════════════════════════════════════════════
// Parse and execute
// ═══════════════════════════════════════════════════════════════════════════════

program.parse();
