import type { Group, RequestParams } from "@threadterm/protocol";
import { mergeGroupMessages } from "./groupComposer";

export type GroupWindowRead = (params: Pick<RequestParams<"group.read">, "before">) => Promise<Group>;

/** Rehydrates the currently rendered suffix on an event without polling or reading past its oldest row. */
export async function readLoadedGroupWindow(read: GroupWindowRead, oldestId?: string): Promise<Group> {
  const newest = await read({});
  if (!oldestId || newest.messages.some(message => message.id === oldestId)) return newest;

  let messages = newest.messages, before = newest.before, hasMore = newest.hasMore, metadata = newest;
  while (hasMore && before) {
    const page = await read({ before });
    messages = mergeGroupMessages(page.messages, messages);
    if (page.revision > metadata.revision) metadata = page;
    if (page.messages.some(message => message.id === oldestId)) break;
    before = page.before;
    hasMore = page.hasMore;
  }
  return { ...metadata, before: newest.before, hasMore: newest.hasMore, messages };
}
