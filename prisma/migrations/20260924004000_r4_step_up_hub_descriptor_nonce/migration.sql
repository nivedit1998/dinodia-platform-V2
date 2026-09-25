ALTER TABLE "StepUpChallenge" ADD COLUMN "hubDescriptorNonceHash" VARCHAR(128);

CREATE UNIQUE INDEX "StepUpChallenge_hubDescriptorNonceHash_key"
  ON "StepUpChallenge"("hubDescriptorNonceHash");
