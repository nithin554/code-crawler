import express from "express";
import { OrderService } from "./service";

export const app = express();
const service = new OrderService();

app.get("/orders/:id", (req, res) => {
  res.json(service.place(req.params.id));
});

app.post("/orders", (req, res) => {
  res.json(service.place(req.body.id));
});
