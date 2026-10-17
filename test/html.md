# HTML 内联与扩展语法

## 内联语义标签

这里有一段 <strong>HTML 加粗</strong> 和 <em>HTML 斜体</em>。

普通文本中可以使用 <mark>高亮</mark>、<kbd>Ctrl</kbd> + <kbd>C</kbd>、<sub>下标</sub>、<sup>上标</sup>、<abbr title="HyperText Markup Language">HTML</abbr>、<small>小号字</small>、<del>删除</del>、<ins>插入</ins>、<span style="color: #e91e63;">带内联样式的 span</span>。

---

## details / summary

<details>
<summary>点击展开</summary>

折叠内容里也可以放 **markdown**：

- 列表项 1
- 列表项 2

</details>

---

## 块级容器

<div style="padding: 12px; border-left: 4px solid #4caf50; background: #f1f8e9;">
  这是一个 <strong>div</strong> 块级容器，里面可以包含普通 HTML。
  <p>也可以包含段落。</p>
</div>

<section>
  <h4>section 内的标题</h4>
  <p>section 是块级语义标签。</p>
</section>

<figure>
  <img src="https://via.placeholder.com/120" alt="figure 图片">
  <figcaption>figure + figcaption 图注</figcaption>
</figure>

---

## 原生 HTML 表格

<table>
  <thead>
    <tr><th>标签</th><th>用途</th></tr>
  </thead>
  <tbody>
    <tr><td><code>&lt;mark&gt;</code></td><td>高亮</td></tr>
    <tr><td><code>&lt;kbd&gt;</code></td><td>键盘按键</td></tr>
    <tr><td><code>&lt;abbr&gt;</code></td><td>缩写</td></tr>
  </tbody>
</table>

---

## 内联 SVG

<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" stroke="#2196f3" stroke-width="4" fill="#bbdefb" />
  <text x="50" y="55" text-anchor="middle" font-size="14" fill="#0d47a1">SVG</text>
</svg>

<svg width="200" height="120" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="40" fill="#ffcdd2" stroke="#c62828" />
  <rect x="110" y="10" width="80" height="40" fill="#c8e6c9" stroke="#2e7d32" />
  <line x1="50" y1="60" x2="150" y2="100" stroke="#3f51b5" stroke-width="3" />
  <polygon points="100,70 120,110 80,110" fill="#fff9c4" stroke="#f9a825" />
</svg>

---

## HTML 注释与转义

<!-- 这是一段 HTML 注释，预览时不应显示 -->

行内实体：&copy; &reg; &trade; &amp; &lt; &gt; &quot; &apos;

---

## 表单元素

<label>
  <input type="checkbox" checked> 已选复选框
</label>
<label>
  <input type="checkbox"> 未选复选框
</label>

<progress value="70" max="100"></progress>
<meter value="0.6">60%</meter>

---

## 多媒体

<video controls width="240">
  <source src="https://www.w3schools.com/html/mov_bbb.mp4" type="video/mp4">
  您的浏览器不支持 video 标签。
</video>

<audio controls>
  <source src="https://www.w3schools.com/html/horse.mp3" type="audio/mpeg">
  您的浏览器不支持 audio 标签。
</audio>

---

## iframe（安全策略允许时）

<iframe src="https://example.com" width="240" height="120" title="iframe 测试"></iframe>