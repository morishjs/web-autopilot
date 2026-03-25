/**
 * gotcha-insert-yaml.ts
 * haiku가 추출한 playbook/gotcha를 site.yaml의 올바른 페이지 섹션에 삽입
 *
 * haiku 출력 형식 (playbook):
 * /page_path:
 *   goal: "목표"
 *   playbook:
 *     - cmd: "browser.ts 명령"
 *       note: "주의사항"
 *
 * 또는 (gotcha만):
 * /page_path:
 *   - gotcha 내용
 *
 * Usage: bun gotcha-insert-yaml.ts <yaml_file> <refined_file>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const yamlFile = process.argv[2];
const refinedFile = process.argv[3];

if (!yamlFile || !refinedFile) {
  console.error("Usage: bun gotcha-insert-yaml.ts <yaml_file> <refined_file>");
  process.exit(1);
}

const refined = readFileSync(refinedFile, "utf-8").trim();
if (!refined || refined === "NONE") {
  console.error("📝 새로운 playbook 없음");
  process.exit(0);
}

let yaml = existsSync(yamlFile) ? readFileSync(yamlFile, "utf-8") : "";

// haiku 출력에서 페이지별 블록 추출
const pageBlocks = new Map<string, string>();
const lines = refined.split("\n");
let currentPage: string | null = null;
let currentBlock: string[] = [];

for (const line of lines) {
  const pageMatch = line.match(/^(\/[\w_-]+):\s*$/);
  if (pageMatch) {
    // 이전 페이지 블록 저장
    if (currentPage && currentBlock.length > 0) {
      pageBlocks.set(currentPage, currentBlock.join("\n"));
    }
    currentPage = pageMatch[1];
    currentBlock = [];
    continue;
  }
  if (currentPage) {
    currentBlock.push(line);
  }
}
// 마지막 블록
if (currentPage && currentBlock.length > 0) {
  pageBlocks.set(currentPage, currentBlock.join("\n"));
}

if (pageBlocks.size === 0) {
  console.error("📝 파싱된 playbook 없음");
  process.exit(0);
}

let added = 0;

for (const [page, block] of pageBlocks) {
  // 중복 체크: goal이나 첫 번째 cmd가 이미 YAML에 있으면 스킵
  const firstCmd = block.match(/cmd:\s*["']?(.{20,60})/);
  if (firstCmd && yaml.includes(firstCmd[1].substring(0, 30))) {
    continue;
  }

  const pageHeader = `  ${page}:`;
  const pageIdx = yaml.indexOf(pageHeader);

  // playbook YAML 블록 생성 (indent 맞추기)
  const indentedBlock = block
    .split("\n")
    .map((l) => (l.trim() ? "    " + l : ""))
    .join("\n");

  if (pageIdx < 0) {
    // 페이지가 없으면 pages: 끝에 새 섹션 추가
    const worktreeIdx = yaml.indexOf("\nworktree:");
    const insertPos = worktreeIdx >= 0 ? worktreeIdx : yaml.length;
    const newSection = `\n  ${page}:\n    description: auto-detected\n${indentedBlock}\n`;
    yaml = yaml.substring(0, insertPos) + newSection + yaml.substring(insertPos);
    added++;
  } else {
    // 기존 페이지의 features: 바로 앞에 삽입
    const afterPage = yaml.substring(pageIdx + pageHeader.length);
    const nextPageMatch = afterPage.match(/\n  \/[\w_-]+:/);
    const nextSectionMatch = afterPage.match(/\n\w+:/);
    let pageEndOffset = afterPage.length;
    if (nextPageMatch?.index !== undefined) pageEndOffset = Math.min(pageEndOffset, nextPageMatch.index);
    if (nextSectionMatch?.index !== undefined) pageEndOffset = Math.min(pageEndOffset, nextSectionMatch.index);

    const pageContent = yaml.substring(pageIdx, pageIdx + pageHeader.length + pageEndOffset);

    // features: 앞에 삽입 (있으면), 없으면 페이지 섹션 끝에
    const featuresIdx = pageContent.indexOf("\n    features:");
    const insertPos = featuresIdx >= 0
      ? pageIdx + featuresIdx
      : pageIdx + pageHeader.length + pageEndOffset;

    yaml = yaml.substring(0, insertPos) + "\n" + indentedBlock + "\n" + yaml.substring(insertPos);
    added++;
  }
}

if (added > 0) {
  writeFileSync(yamlFile, yaml);
  console.error(`📝 ${added}개 페이지에 playbook 추가`);
} else {
  console.error("📝 새로운 playbook 없음 (모두 중복)");
}
