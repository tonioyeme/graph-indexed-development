/**
 * gid design command
 *
 * AI-assisted top-down graph design.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import chalk from 'chalk';
import * as yaml from 'js-yaml';
import { createAIClient, detectAIProvider, AIDesigner, AIProvider, FeatureProposal, ComponentProposal } from '../ai/index.js';
import { Graph, GIDError } from '../core/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface DesignOptions {
  provider?: AIProvider;
  model?: string;
  output?: string;
  force?: boolean;
  nonInteractive?: boolean;
  requirements?: string; // For non-interactive mode
}

// ═══════════════════════════════════════════════════════════════════════════════
// Input Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

function closeReadline(): void {
  rl.close();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function printHeader(title: string): void {
  console.log();
  console.log(chalk.bold(title));
  console.log(chalk.dim('═'.repeat(60)));
}

function printFeatures(features: FeatureProposal[]): void {
  console.log();
  console.log(chalk.cyan('┌' + '─'.repeat(58) + '┐'));
  console.log(chalk.cyan('│') + chalk.bold('  Identified Features'.padEnd(58)) + chalk.cyan('│'));
  console.log(chalk.cyan('├' + '─'.repeat(58) + '┤'));

  features.forEach((f, i) => {
    const checkbox = f.selected !== false ? chalk.green('[x]') : chalk.dim('[ ]');
    const priorityColor =
      f.priority === 'core'
        ? chalk.red
        : f.priority === 'supporting'
          ? chalk.yellow
          : chalk.dim;
    const priority = priorityColor(`(${f.priority})`);

    console.log(
      chalk.cyan('│') +
        `  ${checkbox} ${(i + 1)}. ${f.name.padEnd(30)} ${priority}`.padEnd(58) +
        chalk.cyan('│')
    );
    console.log(
      chalk.cyan('│') +
        chalk.dim(`      ${f.description.slice(0, 48)}`).padEnd(58) +
        chalk.cyan('│')
    );
  });

  console.log(chalk.cyan('└' + '─'.repeat(58) + '┘'));
}

function printComponents(components: ComponentProposal[], featureName: string): void {
  console.log();
  console.log(chalk.cyan('┌' + '─'.repeat(58) + '┐'));
  console.log(
    chalk.cyan('│') +
      chalk.bold(`  Components for "${featureName}"`.padEnd(58)) +
      chalk.cyan('│')
  );
  console.log(chalk.cyan('├' + '─'.repeat(58) + '┤'));

  components.forEach((c) => {
    const layerColor =
      c.layer === 'interface'
        ? chalk.blue
        : c.layer === 'application'
          ? chalk.green
          : c.layer === 'domain'
            ? chalk.yellow
            : chalk.magenta;

    console.log(
      chalk.cyan('│') +
        `  ${chalk.bold(c.name)} ${layerColor(`[${c.layer}]`)}`.padEnd(68) +
        chalk.cyan('│')
    );
    console.log(
      chalk.cyan('│') +
        chalk.dim(`    ${c.description.slice(0, 52)}`).padEnd(58) +
        chalk.cyan('│')
    );
    if (c.dependsOn.length > 0) {
      console.log(
        chalk.cyan('│') +
          chalk.dim(`    → depends_on: ${c.dependsOn.join(', ').slice(0, 40)}`).padEnd(58) +
          chalk.cyan('│')
      );
    }
  });

  console.log(chalk.cyan('└' + '─'.repeat(58) + '┘'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════════════════════════════════

export async function runDesign(options: DesignOptions = {}): Promise<void> {
  try {
    // Detect or use specified provider
    const provider = options.provider || detectAIProvider();
    if (!provider) {
      console.error(chalk.red('Error: No AI provider configured.'));
      console.error();
      console.error('Set one of the following environment variables:');
      console.error('  - OPENAI_API_KEY for OpenAI');
      console.error('  - ANTHROPIC_API_KEY for Anthropic');
      console.error();
      console.error('Or use --provider ollama for local Ollama.');
      process.exit(1);
    }

    console.log();
    console.log(chalk.bold('GID Design - AI-Assisted Graph Generation'));
    console.log(chalk.dim(`Using ${provider}${options.model ? ` (${options.model})` : ''}`));

    // Create AI client and designer
    const client = createAIClient({
      provider,
      model: options.model,
    });
    const designer = new AIDesigner(client);

    // Get requirements
    let requirements: string;
    if (options.nonInteractive && options.requirements) {
      requirements = options.requirements;
    } else {
      printHeader('Step 1: Describe Your Project');
      console.log(chalk.dim('Describe your project or feature in natural language.'));
      console.log(chalk.dim('Press Enter twice when done.'));
      console.log();

      requirements = await getMultilineInput('> ');

      if (!requirements.trim()) {
        console.log(chalk.yellow('No requirements provided. Exiting.'));
        closeReadline();
        return;
      }
    }

    // Step 1: Decompose into features
    console.log();
    console.log(chalk.cyan('Analyzing requirements with AI...'));

    const features = await designer.decomposeFeatures(requirements);

    if (!options.nonInteractive) {
      // Interactive feature review
      let featuresConfirmed = false;
      while (!featuresConfirmed) {
        printFeatures(features);
        console.log();
        console.log(chalk.dim('[Enter] Confirm  [e] Edit  [r] Refine with feedback  [q] Quit'));

        const choice = await question('> ');

        switch (choice.toLowerCase()) {
          case '':
          case 'y':
            featuresConfirmed = true;
            break;

          case 'e': {
            console.log(chalk.dim('Enter feature number to toggle selection, or "d" to delete:'));
            const editChoice = await question('> ');
            const num = parseInt(editChoice, 10);
            if (num > 0 && num <= features.length) {
              features[num - 1].selected = !features[num - 1].selected;
            }
            break;
          }

          case 'r': {
            console.log(chalk.dim('Enter your feedback:'));
            const feedback = await question('> ');
            if (feedback.trim()) {
              console.log(chalk.cyan('Refining features...'));
              const refined = await designer.refineFeatures(feedback);
              features.length = 0;
              features.push(...refined);
            }
            break;
          }

          case 'q':
            console.log(chalk.yellow('Design cancelled.'));
            closeReadline();
            return;
        }
      }
    }

    // Step 2: Design components for each selected feature
    printHeader('Step 2: Component Design');

    const selectedFeatures = features.filter((f) => f.selected !== false);
    const allComponents: ComponentProposal[] = [];

    for (const feature of selectedFeatures) {
      console.log();
      console.log(chalk.cyan(`Designing components for "${feature.name}"...`));

      const components = await designer.designComponents(feature);
      allComponents.push(...components);

      if (!options.nonInteractive) {
        let componentsConfirmed = false;
        while (!componentsConfirmed) {
          printComponents(components, feature.name);
          console.log();
          console.log(chalk.dim('[Enter] Confirm  [r] Refine with feedback'));

          const choice = await question('> ');

          switch (choice.toLowerCase()) {
            case '':
            case 'y':
              componentsConfirmed = true;
              break;

            case 'r': {
              console.log(chalk.dim('Enter your feedback:'));
              const feedback = await question('> ');
              if (feedback.trim()) {
                console.log(chalk.cyan('Refining components...'));
                const refined = await designer.refineComponents(feature.name, feedback);
                components.length = 0;
                components.push(...refined);
              }
              break;
            }
          }
        }
      }
    }

    // Step 3: Generate graph
    printHeader('Step 3: Generate Graph');

    const graph = await designer.generateGraph();

    // Determine output path
    const outputPath = options.output || path.join(process.cwd(), '.gid', 'graph.yml');
    const outputDir = path.dirname(outputPath);

    // Check if file exists
    if (fs.existsSync(outputPath) && !options.force) {
      if (options.nonInteractive) {
        throw new GIDError(
          `Graph file already exists at ${outputPath}. Use --force to overwrite.`,
          'FILE_EXISTS'
        );
      }

      console.log(chalk.yellow(`File exists: ${outputPath}`));
      const overwrite = await question('Overwrite? [y/N] ');
      if (overwrite.toLowerCase() !== 'y') {
        console.log(chalk.yellow('Cancelled.'));
        closeReadline();
        return;
      }
    }

    // Create directory if needed
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write graph
    const yamlContent = yaml.dump(graph, {
      indent: 2,
      lineWidth: 120,
      quotingType: '"',
    });

    fs.writeFileSync(outputPath, yamlContent, 'utf-8');

    // Print summary
    console.log();
    console.log(chalk.green('✓ Graph generated successfully!'));
    console.log();
    console.log(chalk.bold('Summary:'));
    console.log(`  Features:   ${selectedFeatures.length}`);
    console.log(`  Components: ${Object.keys(graph.nodes).length - selectedFeatures.length}`);
    console.log(`  Edges:      ${graph.edges.length}`);
    console.log();
    console.log(`Output: ${chalk.cyan(outputPath)}`);

    // Show next steps
    console.log();
    console.log(chalk.dim('Next steps:'));
    console.log(chalk.dim('  gid check        - Validate the graph'));
    console.log(chalk.dim('  gid query impact - Analyze change impact'));

    closeReadline();
  } catch (err) {
    closeReadline();
    handleError(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function getMultilineInput(prompt: string): Promise<string> {
  const lines: string[] = [];
  let emptyLineCount = 0;

  process.stdout.write(prompt);

  return new Promise((resolve) => {
    const lineHandler = (line: string) => {
      if (line === '') {
        emptyLineCount++;
        if (emptyLineCount >= 2) {
          rl.removeListener('line', lineHandler);
          resolve(lines.join('\n'));
          return;
        }
      } else {
        emptyLineCount = 0;
      }
      lines.push(line);
      process.stdout.write(prompt);
    };

    rl.on('line', lineHandler);
  });
}

function handleError(err: unknown): void {
  if (err instanceof GIDError) {
    console.error();
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  console.error(chalk.red('Unexpected error:'), err);
  process.exit(1);
}
