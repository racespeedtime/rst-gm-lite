import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "@/logger";

/**
 * 敏感词检测（AC 自动机）。
 *
 * 算法与 rst-backend 的 mint-filter（MIT，ZheLin）同构：逐字符 toLowerCase 后
 * 沿 fail 指针匹配，命中即报告/掩码。词库文件与 backend 同约定，部署在服务器
 * 根目录 sensitive-words.txt（每行一个词条，UTF-8；**不提交 git**，见
 * .gitignore，随部署手动放置）。文件缺失时词库为空（检测全部放行），warn 一次提示。
 *
 * 构建在模块加载期完成（6.4 万词约 280ms）：检测入口是聊天/认证热路径，
 * 首次调用才构建会卡住第一个连接的玩家。
 */

interface SensNode {
  children: Map<string, SensNode>;
  fail: SensNode | null;
  depth: number;
  word: boolean;
}

function createNode(depth = 0): SensNode {
  return { children: new Map(), fail: null, depth, word: false };
}

class SensitiveFilter {
  private readonly root: SensNode;

  constructor(keys: string[]) {
    this.root = createNode();
    for (const key of keys) {
      this.addWord(key);
    }
    this.buildFail();
  }

  private addWord(key: string): void {
    const low = key.toLowerCase();
    let node = this.root;
    for (let i = 0; i < low.length; i++) {
      const ch = low[i];
      let next = node.children.get(ch);
      if (!next) {
        next = createNode(i + 1);
        node.children.set(ch, next);
      }
      node = next;
      if (i === low.length - 1) {
        node.word = true;
      }
    }
  }

  /** BFS 构建 fail 指针（标准 AC 自动机） */
  private buildFail(): void {
    const queue: SensNode[] = [this.root];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const [ch, next] of cur.children) {
        let fail = cur.fail;
        while (fail && !fail.children.has(ch)) fail = fail.fail;
        next.fail = fail?.children.get(ch) ?? this.root;
        queue.push(next);
      }
    }
  }

  /** 逐字符扫描。verify=true 命中即停（仅检测）；否则命中段掩码为 *，返回掩码文本 */
  search(text: string, verify = false): { words: string[]; text: string } {
    const chars = text.split("");
    const words: string[] = [];
    let node = this.root;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i].toLowerCase();
      while (node !== this.root && !node.children.has(ch)) node = node.fail!;
      node = node.children.get(ch) ?? this.root;
      if (node.word) {
        const start = i + 1 - node.depth;
        words.push(text.slice(start, i + 1));
        if (verify) break;
        for (let j = start; j <= i; j++) {
          chars[j] = "*";
        }
      }
    }
    return { words, text: chars.join("") };
  }
}

function loadWords(): string[] {
  const file = resolve(process.cwd(), "sensitive-words.txt");
  if (!existsSync(file)) {
    logger.warn(
      "[sensitive] 未找到敏感词库 sensitive-words.txt（放服务器根目录，随部署手动放置、不提交 git），敏感词检测全部放行",
    );
    return [];
  }
  return readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "") // 去 UTF-8 BOM（Windows 编辑器保存的首行会带，trim 不去除）
    .split("\n")
    .map((w) => w.trim())
    .filter(Boolean);
}

const filter = new SensitiveFilter(loadWords());

/** 检测文本是否含敏感词（null/空 → false） */
export function containsSensitiveWord(text: string | null | undefined): boolean {
  if (!text) return false;
  return filter.search(text, true).words.length > 0;
}

/** 敏感词掩码：命中词替换为 *（展示层兜底，如爱车 3D 标签） */
export function filterSensitiveWords(text: string | null | undefined): string {
  if (!text) return "";
  return filter.search(text).text;
}
