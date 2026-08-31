import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, it } from "vitest";
import { AppModule } from "../src/app.module";

describe("AppModule boot", () => {
  const previousWebOrigin = process.env.WEB_ORIGIN;

  beforeAll(() => {
    process.env.WEB_ORIGIN = "https://app.example.test";
  });

  afterAll(() => {
    if (previousWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousWebOrigin;
  });

  it("compiles the production module graph without a database", async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await module.close();
  });
});
