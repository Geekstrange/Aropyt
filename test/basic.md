# 一级标题 H1

## 二级标题 H2

### 三级标题 H3

#### 四级标题 H4

##### 五级标题 H5

###### 六级标题 H6

---

## 段落与换行

这是一个普通段落。Markdown 编辑器需要支持中英文混排：The quick brown fox jumps over the lazy dog.

这是另一个段落，前面有空行分隔。
这一行末尾有两个空格，应当渲染为软换行。

---

## 文本格式

**粗体** 和 __另一种粗体__。

*斜体* 和 _另一种斜体_。

***粗斜体*** 同时生效。

~~删除线~~ 文本。

行内 `code` 片段：`let x = 42`。

可以组合：**加粗里有 `code` 和 *斜体***。

---

## 链接

无 scheme 链接（编辑器应自动补 https）：[百度](www.baidu.com)

完整链接：[Google](https://google.com)

带 title：[Apple](https://apple.com "Apple 官网")

自动链接：<https://github.com>

邮件：<test@example.com>

引用式链接：[点这里][ref-1]

[ref-1]: https://example.com "Example"

---

## 图片

![占位图](https://via.placeholder.com/150 "占位图标题")

引用式图片：![logo][img-ref]

[img-ref]: https://via.placeholder.com/100

---

## 列表

### 无序列表

- 第一项
- 第二项
  - 嵌套 A
  - 嵌套 B
    - 更深一层
- 第三项

### 有序列表

1. 第一步
2. 第二步
   1. 子步骤
   2. 子步骤
3. 第三步

### 任务列表（GFM）

- [x] 已完成的事项
- [x] 另一件已完成
- [ ] 未完成
- [ ] 还没做

### 混合列表

1. 有序父项
   - 无序子项
   - [ ] 任务子项
2. 第二个有序项

---

## 引用

> 这是一个引用块。
>
> 引用可以有多个段落。
>
> > 嵌套引用看起来像这样。
> >
> > > 还能再嵌一层。

> **提示**：引用里也支持其它格式，比如 *斜体*、`code`、[链接](https://example.com)。

---

## GitHub风格警告块

> [!NOTE]
> 用于补充说明，读者浏览时也应知晓的内容。

> [!TIP]
> 更省事或更好的做法。

> [!IMPORTANT]
> 读者必须知道才能完成任务的关键信息。

> [!WARNING]
> 需要立即注意的关键内容。

> [!CAUTION]
> 提示某操作可能带来的负面后果。

---

## 代码块

行内代码：`printf("hello")`

无语言标识的代码块：

```
plain text code block
no syntax highlight
```

Swift：

```swift
import Foundation

struct Point {
    var x: Double
    var y: Double

    func distance(to other: Point) -> Double {
        let dx = x - other.x
        let dy = y - other.y
        return (dx * dx + dy * dy).squareRoot()
    }
}

let p = Point(x: 3, y: 4)
print(p.distance(to: Point(x: 0, y: 0)))
```

JavaScript：

```javascript
const fib = n => {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
};

console.log([0, 1, 2, 3, 4, 5].map(fib));
```

Python：

```python
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    mid = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + mid + quicksort(right)

print(quicksort([3, 6, 1, 8, 2, 9, 4]))
```

Shell：

```sh
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do
  echo "Processing $f"
  wc -l "$f"
done
```

---

## 表格（GFM）

| 语言       | 类型       | 出现年份 |
| ---------- | ---------- | -------- |
| Swift      | 编译型     | 2014     |
| JavaScript | 解释型     | 1995     |
| Python     | 解释型     | 1991     |
| Rust       | 编译型     | 2010     |

对齐方式：

| 左对齐 | 居中 | 右对齐 |
| :----- | :--: | -----: |
| a      |  b   |      c |
| 长一点 |  中  |   1234 |
| x      |  y   |      z |

---

## 分隔线

上面是内容。

---

下面是内容。

***

下面是另一段。

___

---

## 特殊字符

版权 © 注册 ® 商标 ™ 度数 ° 加减 ± 不等于 ≠ 约等于 ≈ 无穷 ∞
