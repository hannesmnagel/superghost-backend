-- Add bot persona support to User
ALTER TABLE "User" ADD COLUMN "isBot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "botLevel" TEXT;

-- CreateIndex
CREATE INDEX "User_isBot_idx" ON "User"("isBot");
