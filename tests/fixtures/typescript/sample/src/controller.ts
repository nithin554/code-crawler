import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { OrderService } from "./service";

@Controller("orders")
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Get(":id")
  read(@Param("id") id: string) {
    return this.service.place(id);
  }

  @Post()
  create(@Body() body: { id: string }) {
    return this.service.place(body.id);
  }
}
