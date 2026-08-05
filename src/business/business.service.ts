import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateLeadDto } from "./dto/create-lead.dto";

@Injectable()
export class BusinessService {
  constructor(private prisma: PrismaService) {}

  createLead(dto: CreateLeadDto) {
    return this.prisma.businessLead.create({ data: dto });
  }

  listLeads() {
    return this.prisma.businessLead.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  }
}
