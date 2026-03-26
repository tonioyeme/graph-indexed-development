/**
 * gid init command
 *
 * Initialize a new graph.yml in the current project.
 */

import chalk from 'chalk';
import { initGraph, findGraphFile } from '../core/parser.js';

export interface InitOptions {
  force?: boolean;
}

export function runInit(options: InitOptions = {}): void {
  // Check if graph already exists
  const existing = findGraphFile();
  if (existing && !options.force) {
    console.log(chalk.yellow('⚠ graph.yml already exists at:'));
    console.log(`  ${chalk.cyan(existing)}`);
    console.log();
    console.log('Use --force to overwrite.');
    process.exit(1);
  }

  try {
    const path = initGraph();

    console.log(chalk.green('✓ Created graph.yml'));
    console.log();
    console.log(`  ${chalk.cyan(path)}`);
    console.log();
    console.log('Next steps:');
    console.log('  1. Edit the graph to add your components');
    console.log('  2. Run `gid query impact <component>` to analyze dependencies');
    console.log();
    console.log(chalk.dim('Learn more: https://github.com/tonioyeme/graph-indexed-development'));
  } catch (err) {
    console.error(chalk.red('Error:'), (err as Error).message);
    process.exit(1);
  }
}
