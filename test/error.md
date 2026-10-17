# 错误与边界测试

## 未闭合的代码块

```javascript
const a = 1;
// 这个代码块没有结束标记

## 未闭合的粗体

这是 **未闭合的粗体文本。

这是 *未闭合的斜体文本。

## 未闭合的链接

这是一个 [未闭合的链接(https://example.com

## 未闭合的图片

![未闭合的图片(https://example.com/a.png

## 未闭合的行内代码

这是 `未闭合的行内代码。

## 空元素

空链接：[]()

空图片：![]()

空标题：

#

空引用：

>

空列表项：

-

## 异常表格

| 缺少分隔行
| --- | --- |

| 列数不一致 | 只有两列 |
| --- | --- | --- |
| 第一列 | 第二列 | 第三列 | 多了一列 |

## 异常的 HTML

<unclosed-tag

<div>未闭合的 div

<strong>未闭合的 strong

## 未闭合的数学公式

行内公式未闭合：$E = mc^2

块级公式未闭合：

$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}

## 未闭合的 Mermaid

```mermaid
flowchart TD
    A[开始] --> B{条件}
    B -- 是 --> C[操作
    C --> D[结束]
```

## 空 Mermaid 块

```mermaid
```

## 非目标语言块不应渲染

```text
flowchart TD
    A --> B
```

```plaintext
$not_math = "$HOME"
```

## 错误的 Mermaid 语法

```mermaid
this is not valid mermaid syntax at all
```

```mermaid
flowchart
    --> --> -->
```

## 转义边界

\*这不是斜体\*

\`这不是行内代码\`

\# 这不是标题

\[这不是链接\](https://example.com)

\\ 反斜杠本身

\~ 波浪号

## 嵌套错误

> 引用里嵌套了 **粗体却没有闭合

- 列表里嵌套了 [链接](https://example.com 却没有闭合括号

## 超长单行

aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

## 连续特殊字符

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

****************************************

########################################

$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%