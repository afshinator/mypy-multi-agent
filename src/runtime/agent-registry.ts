/**
 * Single authority for agent identity: binds connections to registered agent
 * IDs and verifies that a message's sender matches its connection.
 */
export class AgentRegistry {
  private agents = new Map<string, string>(); // agentId -> connectionId
  private connections = new Map<string, string>(); // connectionId -> agentId

  register(connectionId: string, agentId: string): void {
    if (this.agents.has(agentId)) throw new Error(`duplicate agent id: ${agentId}`);
    if (this.connections.has(connectionId)) throw new Error(`connection already registered: ${connectionId}`);
    this.agents.set(agentId, connectionId);
    this.connections.set(connectionId, agentId);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  agentOf(connectionId: string): string | undefined {
    return this.connections.get(connectionId);
  }

  connectionOf(agentId: string): string | undefined {
    return this.agents.get(agentId);
  }

  verifySender(connectionId: string, sender: string): boolean {
    return this.connections.get(connectionId) === sender;
  }
}
