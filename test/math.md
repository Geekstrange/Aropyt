# 数学公式测试

## 行内公式

行内公式：$E = mc^2$，以及 $\alpha + \beta = \gamma$。

常见上下标：$x_i^2 + y_i^2 = r^2$。

分数与根号：$\frac{a+b}{c+d}$，$\sqrt{x^2 + y^2}$。

求和与积分：$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$，$\int_0^1 x^2 \, dx = \frac{1}{3}$。

圆括号定界的行内公式：\( a^2 + b^2 = c^2 \)。

行内极限：\(\lim_{x \to 0} \frac{\sin x}{x} = 1\)。

行内集合：\( A = \{x \in \mathbb{R} \mid x > 0\} \)。

行内逻辑：\( \forall x \in X, \exists y \in Y: f(x) = y \)。

---

## 块级公式

独立块级公式：

$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}
$$

\[...\] 块级公式：

\[
e^{i\pi} + 1 = 0
\]

带编号风格的方程：

\[
\tag{1}
P(A \mid B) = \frac{P(B \mid A)P(A)}{P(B)}
\]

多行对齐公式：

$$
\begin{aligned}
f(x) &= ax^2 + bx + c \\
f'(x) &= 2ax + b
\end{aligned}
$$

方程组：

\[
\begin{cases}
2x + 3y = 7 \\
4x - y = 5
\end{cases}
\]

矩阵：

$$
\begin{bmatrix}
1 & 2 & 3 \\
4 & 5 & 6 \\
7 & 8 & 9
\end{bmatrix}
$$

行列式：

\[
\det(A) =
\begin{vmatrix}
a & b \\
c & d
\end{vmatrix}
= ad - bc
\]

分段函数：

\[
f(x) =
\begin{cases}
x^2, & \text{if } x \ge 0 \\
-x, & \text{if } x < 0
\end{cases}
\]

大括号与括号缩放：

\[
\displaystyle
\left( \frac{1}{n} \sum_{i=1}^{n} x_i \right)^2
\le
\frac{1}{n} \sum_{i=1}^{n} x_i^2
\]

向量与范数：

\[
\mathbf{v} = \begin{pmatrix} v_1 \\ v_2 \\ v_3 \end{pmatrix},
\qquad
\lVert \mathbf{v} \rVert_2 = \sqrt{v_1^2 + v_2^2 + v_3^2}
\]

希腊字母与偏导：

\[
\frac{\partial^2 u}{\partial t^2}
= c^2 \left(
\frac{\partial^2 u}{\partial x^2}
+ \frac{\partial^2 u}{\partial y^2}
\right)
\]

概率与期望：

\[
\mathbb{E}[X] = \sum_x x P(X=x),
\qquad
\operatorname{Var}(X) = \mathbb{E}[X^2] - \mathbb{E}[X]^2
\]

上下标复杂组合：

\[
T^{\mu\nu}_{\alpha\beta}
= \sum_{i,j=1}^{n} A_{ij}^{(k)} B_{ji}^{(k+1)}
\]

---

## 表格里的行内公式

| 表达式 | 含义 |
| --- | --- |
| $a_n$ | 第 n 项 |
| $\Delta x$ | 变量增量 |
| \( \nabla f \) | 梯度 |

---

## 边界：代码中不应渲染

代码中的美元符号不应当被当作公式：`echo "$HOME"`。

代码块中的公式定界符也不应当被渲染：

```tex
$not_math = "$HOME"
\[
not rendered here
\]
```