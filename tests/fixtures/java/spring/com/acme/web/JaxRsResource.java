package com.acme.web;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

/**
 * JAX-RS, not Spring. `@Path` and `@GET` are not registered mapping annotations,
 * so this file must produce no routes at all.
 */
@Path("/legacy")
public class JaxRsResource {

  @GET
  public String read() {
    return null;
  }
}
