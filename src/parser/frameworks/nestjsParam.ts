import type { FrameworkModule } from "./types.js";

/** Parameter decorators that bind a request value rather than inject a dependency. */
export const nestjsParam: FrameworkModule = {
  name: "nestjs-param",
  evidence: ["@nestjs/"],
  injections: {
    Body: true,
    Param: true,
    Query: true,
    Headers: true,
    Req: true,
    Res: true,
    Session: true,
    UploadedFile: true,
    UploadedFiles: true,
    Ip: true,
    HostParam: true,
  },
};
