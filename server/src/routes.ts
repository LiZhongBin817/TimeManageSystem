import { Router } from 'express';
import { z } from 'zod';
import { login, requireAuth } from './auth';
import { canEdit, canRead, findModule, modules } from './config/modules';
import { all, addAuditLog } from './db';
import { dingTalkClient } from './dingtalk/client';

export const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

router.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: '用户名和密码不能为空' });
    return;
  }

  const result = await login(parsed.data.username, parsed.data.password);
  if (!result) {
    res.status(401).json({ message: '用户名或密码错误' });
    return;
  }
  res.json(result);
});

router.use(requireAuth);

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.get('/modules', (req, res) => {
  const role = req.user!.role;
  res.json({
    modules: modules
      .filter((item) => canRead(role, item.key))
      .map((item) => ({ ...item, canEdit: item.editable && canEdit(role, item.key) }))
  });
});

router.get('/staff-options', async (req, res, next) => {
  try {
    const staffModule = findModule('staff');
    if (!staffModule || !canRead(req.user!.role, staffModule.key)) {
      res.status(404).json({ message: '人员信息模块不存在或无权访问' });
      return;
    }

    const rows = await dingTalkClient.getRows(staffModule);
    const unique = (key: string) =>
      Array.from(new Set(rows.map((row) => String(row[key] || '').trim()).filter((value) => value && value !== '-')));

    res.json({
      product: unique('productOwner'),
      tester: unique('tester'),
      developer: unique('developer')
    });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard/summary', async (req, res, next) => {
  try {
    const projectModules = modules.filter((item) => ['power-standard', 'sales-standard', 'crawler', 'province-system'].includes(item.key) && canRead(req.user!.role, item.key));
    const moduleStats: Array<{
      key: string;
      title: string;
      total: number;
      done: number;
      unfinished: number;
      developing: number;
      testing: number;
      completionRate: number;
      progressText: string;
      developingVersions: string[];
      testingVersions: string[];
      error?: string;
      editable: boolean;
    }> = [];
    const developerNames = new Set<string>();
    const developerRows: Record<string, Record<string, { total: number; done: number; unfinished: number }>> = {};

    const isDone = (value: unknown) => ['是', '已完成', '完成', 'true'].includes(String(value || '').trim().toLowerCase());
    const versionName = (row: Record<string, unknown>) => String(row.name || row.content || row.branchName || '').trim();
    const isTesting = (row: Record<string, unknown>) => {
      const text = `${row.name || ''} ${row.content || ''} ${row.remark || ''}`.toLowerCase();
      return text.includes('测试') || text.includes('test');
    };
    const pushDeveloperStat = (name: string, moduleTitle: string, done: boolean) => {
      const cleanName = name.trim();
      if (!cleanName || cleanName === '-') return;
      developerNames.add(cleanName);
      developerRows[cleanName] ||= {};
      developerRows[cleanName][moduleTitle] ||= { total: 0, done: 0, unfinished: 0 };
      developerRows[cleanName][moduleTitle].total += 1;
      if (done) developerRows[cleanName][moduleTitle].done += 1;
      else developerRows[cleanName][moduleTitle].unfinished += 1;
    };

    for (const module of projectModules) {
      let rows: Awaited<ReturnType<typeof dingTalkClient.getRows>> = [];
      let error: string | undefined;
      try {
        rows = await dingTalkClient.getRows(module);
      } catch (failure: any) {
        error = failure.response?.data?.message || failure.message || '读取失败';
      }
      const done = rows.filter((row) => isDone(row.isCompleted)).length;
      const unfinishedRows = rows.filter((row) => !isDone(row.isCompleted));
      const testingRows = unfinishedRows.filter((row) => isTesting(row));
      const developingRows = unfinishedRows.filter((row) => !isTesting(row));
      for (const row of rows) {
        String(row.developer || '')
          .split(/[、,，/]/)
          .forEach((name) => pushDeveloperStat(name, module.title, isDone(row.isCompleted)));
      }
      const completionRate = rows.length ? Math.round((done / rows.length) * 100) : 0;
      moduleStats.push({
        key: module.key,
        title: module.title,
        total: rows.length,
        done,
        unfinished: rows.length - done,
        developing: developingRows.length,
        testing: testingRows.length,
        completionRate,
        progressText: '☆'.repeat(Math.max(1, Math.round(completionRate / 10))),
        developingVersions: developingRows.map(versionName).filter(Boolean),
        testingVersions: testingRows.map(versionName).filter(Boolean),
        error,
        editable: module.editable && canEdit(req.user!.role, module.key)
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const totalRows = moduleStats.reduce((sum, item) => sum + item.total, 0);
    const totalDone = moduleStats.reduce((sum, item) => sum + item.done, 0);
    const overallRate = totalRows ? Math.round((totalDone / totalRows) * 100) : 0;
    res.json({
      source: dingTalkClient.isConfigured ? 'dingtalk' : 'mock',
      currentDate: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      cards: [
        { label: '项目模块', value: moduleStats.length },
        { label: '总需求数', value: totalRows },
        { label: '总已完成数', value: totalDone },
        { label: '整体完成率', value: `${overallRate}%` }
      ],
      overview: { totalRows, totalDone, overallRate },
      moduleStats,
      developerStats: Array.from(developerNames).map((name) => ({
        name,
        modules: moduleStats.map((module) => ({
          title: module.title,
          ...(developerRows[name]?.[module.title] || { total: 0, done: 0, unfinished: 0 })
        }))
      })),
      trend: moduleStats.map((item) => ({ name: item.title, total: item.total, done: item.done, unfinished: item.unfinished }))
    });
  } catch (error) {
    next(error);
  }
});

router.get('/sheets/:module/rows', async (req, res, next) => {
  try {
    const module = findModule(req.params.module);
    if (!module || !canRead(req.user!.role, module.key)) {
      res.status(404).json({ message: '模块不存在或无权访问' });
      return;
    }

    const rows = await dingTalkClient.getRows(module);
    res.json({ module, canEdit: module.editable && canEdit(req.user!.role, module.key), rows });
  } catch (error) {
    next(error);
  }
});

router.post('/sheets/:module/rows', async (req, res, next) => {
  try {
    const module = findModule(req.params.module);
    if (!module || !module.editable || !canEdit(req.user!.role, module.key)) {
      res.status(403).json({ message: '没有新增权限' });
      return;
    }

    const row = await dingTalkClient.createRow(module, req.body);
    await addAuditLog({ userId: req.user!.id, username: req.user!.username, moduleKey: module.key, action: 'create', rowId: row.id, payload: req.body });
    res.status(201).json({ row });
  } catch (error) {
    next(error);
  }
});

router.put('/sheets/:module/rows/:rowId', async (req, res, next) => {
  try {
    const module = findModule(req.params.module);
    if (!module || !module.editable || !canEdit(req.user!.role, module.key)) {
      res.status(403).json({ message: '没有编辑权限' });
      return;
    }

    const row = await dingTalkClient.updateRow(module, req.params.rowId, req.body);
    await addAuditLog({ userId: req.user!.id, username: req.user!.username, moduleKey: module.key, action: 'update', rowId: req.params.rowId, payload: req.body });
    res.json({ row });
  } catch (error) {
    next(error);
  }
});

router.delete('/sheets/:module/rows/:rowId', async (req, res, next) => {
  try {
    const module = findModule(req.params.module);
    if (!module || !module.editable || !canEdit(req.user!.role, module.key)) {
      res.status(403).json({ message: '没有删除权限' });
      return;
    }

    await dingTalkClient.deleteRow(module, req.params.rowId);
    await addAuditLog({ userId: req.user!.id, username: req.user!.username, moduleKey: module.key, action: 'delete', rowId: req.params.rowId });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/audit-logs', async (req, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ message: '只有管理员可以查看操作日志' });
    return;
  }

  const logs = await all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');
  res.json({ logs });
});
