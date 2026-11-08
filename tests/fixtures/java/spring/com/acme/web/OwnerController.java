package com.acme.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * A class-level prefix with every method-level path form Spring accepts.
 */
@RestController
@RequestMapping("/owners/{ownerId}")
public class OwnerController {

  @GetMapping("/pets")
  public String listPets() {
    return null;
  }

  @PostMapping(path = "/pets")
  public String addPet() {
    return null;
  }

  @RequestMapping(path = "/pets/{petId}", method = RequestMethod.PUT)
  public String updatePet() {
    return null;
  }

  @GetMapping({ "/visits", "/appointments" })
  public String visits() {
    return null;
  }

  public String helper() {
    return null;
  }
}
