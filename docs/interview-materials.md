# 面试资料入口

`#materials?tab=interviews` 按公司、通用分组。详情使用
`#materials/interview?key=...`。岗位「怎么准备」优先打开该岗位的资料，
不会因为查看资料而生成内容、排任务或改变岗位状态。

只读来源按原有身份关联：

- `state/interview-dossiers/<record_id>.json`：团队生成的资料，保留每项依据。
- 岗位的 `interview_dossier`：已发布的固定文档及本机备份；核对文档身份、已登记版本及内容指纹。
- `config/interview-guide.json`：通用讲义的原文入口。
- `candidate/interviews/index.json`：本人已有本机资料的私有目录，不进源码包。

私有目录格式（内容文件为 UTF-8 Markdown、TXT 或文档 XML，最多 2 MB）：

```json
{
  "version": 1,
  "items": [{
    "key": "example-preparation",
    "title": "示例公司 · 面试准备",
    "company": "示例公司",
    "record_id": "existing-record-id",
    "path": "candidate/interviews/example-preparation.md",
    "source_label": "原有本机资料",
    "updated_at": "2026-10-01T00:00:00Z"
  }]
}
```

`company`、`record_id` 均为空时归通用。有稳定岗位身份时使用该岗位的公司，
不能把一个岗位的资料配到另一家公司。显式绑定的岗位不在库时保留原身份，
不退成公司通用资料；目录仍可读，并说明原岗位不可用。可选 `source_url` 保留原文链接，
`original_path` 只用于把已登记材料之间的相对引用转为站内链接，不向网页返回路径。
同一个原文 URL 的通用讲义不会重复列出。

接口 `GET /api/materials/interviews` 返回目录，
`GET /api/materials/interview?key=...` 只读已登记条目。
不能通过请求传任意文件路径。缺失、越界、版本不符时明确说明，不改选另一份资料。
原文 HTML 仅保留安全的排版元素；Markdown 普通文字先转义。
