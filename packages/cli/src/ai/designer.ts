/**
 * AI Designer
 *
 * Orchestrates AI-assisted top-down graph design.
 */

import {
  AIClient,
  FeatureProposal,
  ComponentProposal,
  DesignContext,
  ConversationTurn,
  DesignProposal,
  EdgeProposal,
} from './types.js';
import { Graph, Node, Edge, GIDError } from '../core/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// System Prompts
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a software architect assistant helping to design software systems using the Graph-Indexed Development (GID) methodology.

GID represents software as a graph where:
- Features: User-perceivable functionality
- Components: Technical modules that implement features
- Edges: Relationships (implements, depends_on)

Your responses should be valid JSON that can be parsed directly.`;

// ═══════════════════════════════════════════════════════════════════════════════
// AIDesigner Class
// ═══════════════════════════════════════════════════════════════════════════════

export class AIDesigner {
  private client: AIClient;
  private context: DesignContext;
  private history: ConversationTurn[] = [];

  constructor(client: AIClient) {
    this.client = client;
    this.context = {
      requirements: '',
      features: [],
      components: [],
      edges: [],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1: Feature Decomposition
  // ═══════════════════════════════════════════════════════════════════════════

  async decomposeFeatures(requirements: string): Promise<FeatureProposal[]> {
    this.context.requirements = requirements;

    const prompt = `Given the following project requirements, identify the user-perceivable Features.

Requirements:
${requirements}

Return ONLY a JSON array of features (no markdown, no explanation):
[
  {
    "name": "Feature Name",
    "description": "One sentence description of what users can do",
    "priority": "core" | "supporting" | "generic"
  }
]

Guidelines:
- A Feature is something a user can perceive or interact with
- "core" = essential for MVP, the product doesn't work without it
- "supporting" = enhances core features, improves user experience
- "generic" = nice to have, can be added later
- Use PascalCase for feature names (e.g., "UserAuthentication", "TaskManagement")
- Keep descriptions user-focused, not technical`;

    const response = await this.client.complete(prompt, { systemPrompt: SYSTEM_PROMPT });
    const features = this.parseJSON<FeatureProposal[]>(response, 'features');

    // Mark all as selected by default
    features.forEach((f) => (f.selected = true));

    this.context.features = features;
    this.history.push({ role: 'user', content: requirements });
    this.history.push({ role: 'assistant', content: response });

    return features;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2: Component Design (per Feature)
  // ═══════════════════════════════════════════════════════════════════════════

  async designComponents(feature: FeatureProposal): Promise<ComponentProposal[]> {
    const existingComponents =
      this.context.components.length > 0
        ? `\nExisting Components in the system:\n${this.context.components.map((c) => `- ${c.name}: ${c.description}`).join('\n')}`
        : '';

    const prompt = `Design the technical Components needed to implement this Feature.

Feature: ${feature.name}
Description: ${feature.description}
${existingComponents}

Return ONLY a JSON array (no markdown, no explanation):
[
  {
    "name": "ComponentName",
    "description": "What this component does (technical responsibility)",
    "layer": "interface" | "application" | "domain" | "infrastructure",
    "isNew": true,
    "dependsOn": ["OtherComponentName"]
  }
]

Layer guidelines:
- "interface": UI components, API endpoints, CLI handlers
- "application": Business logic orchestration, use cases, services
- "domain": Core business entities, rules, value objects
- "infrastructure": Database, external APIs, file system, caching

Guidelines:
- Use PascalCase for component names
- Keep components focused (single responsibility)
- Set "isNew": false if reusing an existing component
- Only list direct dependencies in "dependsOn"`;

    const response = await this.client.complete(prompt, { systemPrompt: SYSTEM_PROMPT });
    const components = this.parseJSON<ComponentProposal[]>(response, 'components');

    // Mark which feature each component implements
    components.forEach((c) => (c.implementsFeature = feature.name));

    // Add to context (avoid duplicates)
    for (const comp of components) {
      const existing = this.context.components.find((c) => c.name === comp.name);
      if (!existing) {
        this.context.components.push(comp);
      }
    }

    return components;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3: Generate Complete Graph
  // ═══════════════════════════════════════════════════════════════════════════

  async generateGraph(): Promise<Graph> {
    const nodes: Record<string, Node> = {};
    const edges: Edge[] = [];

    // Add Feature nodes
    for (const feature of this.context.features) {
      if (!feature.selected) continue;

      nodes[feature.name] = {
        type: 'Feature',
        description: feature.description,
        priority: feature.priority,
        status: 'draft',
      };
    }

    // Add Component nodes and edges
    for (const comp of this.context.components) {
      nodes[comp.name] = {
        type: 'Component',
        description: comp.description,
        layer: comp.layer,
        status: 'draft',
      };

      // Add implements edge
      if (comp.implementsFeature && nodes[comp.implementsFeature]) {
        edges.push({
          from: comp.name,
          to: comp.implementsFeature,
          relation: 'implements',
        });
      }

      // Add depends_on edges
      for (const dep of comp.dependsOn) {
        if (nodes[dep] || this.context.components.some((c) => c.name === dep)) {
          edges.push({
            from: comp.name,
            to: dep,
            relation: 'depends_on',
          });
        }
      }
    }

    return { nodes, edges };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Full Design Flow
  // ═══════════════════════════════════════════════════════════════════════════

  async fullDesign(requirements: string): Promise<DesignProposal> {
    // Step 1: Decompose into features
    const features = await this.decomposeFeatures(requirements);

    // Step 2: Design components for each feature
    const components: ComponentProposal[] = [];
    for (const feature of features) {
      if (feature.selected !== false) {
        const featureComponents = await this.designComponents(feature);
        components.push(...featureComponents);
      }
    }

    // Build edges
    const edges: EdgeProposal[] = [];
    for (const comp of components) {
      if (comp.implementsFeature) {
        edges.push({
          from: comp.name,
          to: comp.implementsFeature,
          relation: 'implements',
        });
      }
      for (const dep of comp.dependsOn) {
        edges.push({
          from: comp.name,
          to: dep,
          relation: 'depends_on',
        });
      }
    }

    return { features, components, edges };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feedback Handling
  // ═══════════════════════════════════════════════════════════════════════════

  async refineFeatures(feedback: string): Promise<FeatureProposal[]> {
    const prompt = `The user provided feedback on the feature suggestions.

Current features:
${JSON.stringify(this.context.features, null, 2)}

User feedback: "${feedback}"

Return ONLY the revised JSON array of features (no markdown, no explanation):`;

    const response = await this.client.complete(prompt, { systemPrompt: SYSTEM_PROMPT });
    const features = this.parseJSON<FeatureProposal[]>(response, 'features');

    features.forEach((f) => (f.selected = true));
    this.context.features = features;

    this.history.push({ role: 'user', content: feedback });
    this.history.push({ role: 'assistant', content: response });

    return features;
  }

  async refineComponents(featureName: string, feedback: string): Promise<ComponentProposal[]> {
    const featureComponents = this.context.components.filter(
      (c) => c.implementsFeature === featureName
    );

    const prompt = `The user provided feedback on the component design.

Feature: ${featureName}
Current components:
${JSON.stringify(featureComponents, null, 2)}

User feedback: "${feedback}"

Return ONLY the revised JSON array of components (no markdown, no explanation):`;

    const response = await this.client.complete(prompt, { systemPrompt: SYSTEM_PROMPT });
    const components = this.parseJSON<ComponentProposal[]>(response, 'components');

    // Update context
    this.context.components = this.context.components.filter(
      (c) => c.implementsFeature !== featureName
    );
    components.forEach((c) => (c.implementsFeature = featureName));
    this.context.components.push(...components);

    return components;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Context Access
  // ═══════════════════════════════════════════════════════════════════════════

  getContext(): DesignContext {
    return { ...this.context };
  }

  setFeatures(features: FeatureProposal[]): void {
    this.context.features = features;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private parseJSON<T>(response: string, context: string): T {
    // Try to extract JSON from the response (handle markdown code blocks)
    let jsonStr = response.trim();

    // Remove markdown code blocks if present
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    try {
      return JSON.parse(jsonStr) as T;
    } catch (e) {
      throw new GIDError(
        `Failed to parse AI response for ${context}. Response was: ${response.slice(0, 200)}...`,
        'AI_ERROR'
      );
    }
  }
}
