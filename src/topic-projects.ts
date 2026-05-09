import type { PluginContext } from "@paperclipai/plugin-sdk";

type TopicMappingRecord = {
  projectId?: string;
  projectName: string;
  topicId: string;
};

type TopicMappingValue = string | TopicMappingRecord;
type TopicMap = Record<string, TopicMappingValue>;

function normalizeTopicMapping(projectName: string, value: TopicMappingValue): TopicMappingRecord {
  if (typeof value === "string") {
    return { projectName, topicId: value };
  }
  return {
    projectId: value.projectId,
    projectName: value.projectName || projectName,
    topicId: value.topicId,
  };
}

export async function resolveMappedProjectIdForTopic(
  ctx: PluginContext,
  chatId: string,
  companyId: string,
  messageThreadId?: number,
): Promise<string | undefined> {
  if (!messageThreadId) return undefined;

  const topicMap = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as TopicMap | null;
  if (!topicMap) return undefined;

  const topicId = String(messageThreadId);
  const match = Object.entries(topicMap)
    .map(([projectName, value]) => normalizeTopicMapping(projectName, value))
    .find((mapping) => mapping.topicId === topicId);

  if (!match) return undefined;
  if (match.projectId) return match.projectId;

  try {
    const projects = await ctx.projects.list({ companyId, limit: 100 });
    const exactMatch = projects.find((project) => project.name === match.projectName);
    if (exactMatch) return exactMatch.id;
    return projects.find((project) => project.name?.toLowerCase() === match.projectName.toLowerCase())?.id;
  } catch (err) {
    ctx.logger.warn("Failed to look up project for legacy topic mapping", {
      chatId,
      companyId,
      projectName: match.projectName,
      error: String(err),
    });
    return undefined;
  }
}
