-- Both sides need to know whether a message landed. A passenger asking
-- "which gate?" currently has no idea if their rider has seen it.
ALTER TABLE "chat_messages" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "chat_messages" ADD COLUMN "readAt" TIMESTAMP(3);
-- Unread counts are "messages in this thread not sent by me and not read".
CREATE INDEX "chat_messages_contextType_contextId_readAt_idx"
  ON "chat_messages" ("contextType", "contextId", "readAt");
