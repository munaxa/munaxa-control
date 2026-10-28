import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { ForOperators, RequirePermission } from '../auth/decorators';
import { ControlPermission } from '../auth/permissions';
import { uuidParam } from '../core/http';
import { keySchema } from '../core/products';
import { ZodPipe } from '../core/validation';
import { UsageService } from '../usage/usage.service';
import { ReportsService } from './reports.service';

const auditQuery = z.object({
  customerId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  before: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const historyQuery = z.object({
  metric: keySchema,
  limit: z.coerce.number().int().min(1).max(500).default(90),
});

@Controller({ path: 'admin' })
@ForOperators()
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('dashboard')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_READ)
  dashboard() {
    return this.reports.dashboard();
  }

  @Get('reports/expiring')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_READ)
  expiring(@Query(new ZodPipe(daysQuery)) query: z.infer<typeof daysQuery>) {
    return this.reports.expiring(query.days);
  }

  @Get('reports/overdue')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_READ)
  overdue() {
    return this.reports.overdue();
  }

  @Get('tenants/:id/usage')
  @RequirePermission(ControlPermission.USAGE_READ)
  latestUsage(@Param('id', new ZodPipe(uuidParam)) id: string) {
    return this.usage.latest(id);
  }

  @Get('tenants/:id/usage/history')
  @RequirePermission(ControlPermission.USAGE_READ)
  usageHistory(
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Query(new ZodPipe(historyQuery)) query: z.infer<typeof historyQuery>,
  ) {
    return this.usage.history(id, query.metric, query.limit);
  }

  @Get('audit')
  @RequirePermission(ControlPermission.AUDIT_READ)
  auditEvents(@Query(new ZodPipe(auditQuery)) query: z.infer<typeof auditQuery>) {
    return this.audit.list(query);
  }
}
