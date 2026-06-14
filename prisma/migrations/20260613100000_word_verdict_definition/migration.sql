-- Store the definition alongside the validity judgement so the two never disagree.
ALTER TABLE "WordVerdict" ADD COLUMN "definition" TEXT;
