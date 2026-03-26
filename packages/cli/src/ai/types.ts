/**
 * AI Module Types
 *
 * Type definitions for AI-assisted design functionality.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// AI Client Types
// ═══════════════════════════════════════════════════════════════════════════════

export type AIProvider = 'openai' | 'anthropic' | 'ollama';

export interface AIClientConfig {
  provider: AIProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AICompletionOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AIClient {
  complete(prompt: string, options?: AICompletionOptions): Promise<string>;
  chat(messages: AIMessage[], options?: AICompletionOptions): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Design Proposal Types
// ═══════════════════════════════════════════════════════════════════════════════

export type FeaturePriority = 'core' | 'supporting' | 'generic';
export type ComponentLayer = 'interface' | 'application' | 'domain' | 'infrastructure';

export interface FeatureProposal {
  name: string;
  description: string;
  priority: FeaturePriority;
  selected?: boolean;
}

export interface ComponentProposal {
  name: string;
  description: string;
  layer: ComponentLayer;
  isNew: boolean;
  dependsOn: string[];
  implementsFeature?: string;
}

export interface EdgeProposal {
  from: string;
  to: string;
  relation: 'implements' | 'depends_on';
}

export interface DesignProposal {
  features: FeatureProposal[];
  components: ComponentProposal[];
  edges: EdgeProposal[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Design Session Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface DesignContext {
  requirements: string;
  features: FeatureProposal[];
  components: ComponentProposal[];
  edges: EdgeProposal[];
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DesignSession {
  context: DesignContext;
  history: ConversationTurn[];
}
