# Mermaid 彩色测试

## 主题变量（themeVariables）— 流程图

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'primaryColor': '#ffeb3b',
  'primaryTextColor': '#212121',
  'primaryBorderColor': '#f57f17',
  'lineColor': '#d81b60',
  'secondaryColor': '#bbdefb',
  'tertiaryColor': '#c8e6c9',
  'background': '#fafafa',
  'fontSize': '16px'
}}}%%
flowchart LR
    A[主色节点] --> B[次色节点]
    B --> C[第三色节点]
    C --> A
```

## classDef 着色 — 流程图

```mermaid
flowchart TD
    A[默认节点] --> B[成功]
    A --> C[警告]
    A --> D[错误]
    A --> E[信息]

    classDef success fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20
    classDef warn fill:#fff9c4,stroke:#f9a825,stroke-width:2px,color:#f57f17
    classDef error fill:#ffcdd2,stroke:#c62828,stroke-width:2px,color:#b71c1c
    classDef info fill:#bbdefb,stroke:#1565c0,stroke-width:2px,color:#0d47a1

    class B success
    class C warn
    class D error
    class E info
```

## style 内联着色 — 流程图

```mermaid
flowchart LR
    A[红] --> B[橙] --> C[黄] --> D[绿] --> E[蓝] --> F[紫]

    style A fill:#ffcdd2,stroke:#c62828,color:#b71c1c
    style B fill:#ffe0b2,stroke:#ef6c00,color:#e65100
    style C fill:#fff9c4,stroke:#f9a825,color:#f57f17
    style D fill:#c8e6c9,stroke:#2e7d32,color:#1b5e20
    style E fill:#bbdefb,stroke:#1565c0,color:#0d47a1
    style F fill:#e1bee7,stroke:#6a1b9a,color:#4a148c
```

## linkStyle 着色 — 连线颜色

```mermaid
flowchart LR
    A --> B --> C --> D

    linkStyle 0 stroke:#e91e63,stroke-width:3px
    linkStyle 1 stroke:#3f51b5,stroke-width:3px
    linkStyle 2 stroke:#009688,stroke-width:3px
```

## 彩色时序图

```mermaid
sequenceDiagram
    participant A as 客户端
    participant B as 服务端
    participant C as 数据库

    A->>B: 请求数据
    B->>C: 查询
    C-->>B: 返回结果
    B-->>A: 响应

    Note over A,B: 这一块是 Note
    Note over C: 数据库注释

    rect rgb(255, 235, 238)
        A->>B: 高亮区域内的消息
        B-->>A: 回复
    end
```

## 彩色状态图

```mermaid
stateDiagram-v2
    [*] --> 空闲
    空闲 --> 加载中: 开始
    加载中 --> 成功: 完成
    加载中 --> 失败: 出错
    成功 --> [*]
    失败 --> 空闲: 重试

    classDef idle fill:#e3f2fd,stroke:#1565c0
    classDef loading fill:#fff9c4,stroke:#f9a825
    classDef ok fill:#c8e6c9,stroke:#2e7d32
    classDef err fill:#ffcdd2,stroke:#c62828

    class 空闲 idle
    class 加载中 loading
    class 成功 ok
    class 失败 err
```

## 彩色饼图

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'pie1': '#e53935',
  'pie2': '#fb8c00',
  'pie3': '#fdd835',
  'pie4': '#43a047',
  'pie5': '#1e88e5',
  'pie6': '#8e24aa',
  'pieTitleTextSize': '20px'
}}}%%
pie showData title 彩色饼图测试
    "红" : 20
    "橙" : 15
    "黄" : 10
    "绿" : 25
    "蓝" : 20
    "紫" : 10
```

## 彩色甘特图

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'sectionBkgColor': '#e3f2fd',
  'altSectionBkgColor': '#f3e5f5',
  'taskBkgColor': '#90caf9',
  'taskBorderColor': '#1565c0',
  'activeTaskBkgColor': '#ffb74d',
  'doneTaskBkgColor': '#a5d6a7',
  'critBkgColor': '#ef5350'
}}}%%
gantt
    title 彩色甘特图
    dateFormat YYYY-MM-DD
    section 阶段一
    任务 A :a1, 2024-01-01, 5d
    任务 B :a2, after a1, 4d
    section 阶段二
    任务 C :b1, after a2, 6d
    任务 D :b2, after b1, 3d
```

## 彩色类图

```mermaid
classDiagram
    class Animal {
        +String name
        +eat()
    }
    class Dog {
        +bark()
    }
    class Cat {
        +meow()
    }
    Animal <|-- Dog
    Animal <|-- Cat

    style Animal fill:#bbdefb,stroke:#1565c0,color:#0d47a1
    style Dog fill:#c8e6c9,stroke:#2e7d32,color:#1b5e20
    style Cat fill:#f8bbd0,stroke:#c2185b,color:#880e4f
```

## 深色主题（dark）

```mermaid
%%{init: {'theme':'dark'}}%%
flowchart LR
    A[Dark 节点 A] --> B[Dark 节点 B]
    B --> C[Dark 节点 C]
```

## 森林主题（forest）

```mermaid
%%{init: {'theme':'forest'}}%%
flowchart TD
    A[Forest 根] --> B[叶子 1]
    A --> C[叶子 2]
    B --> D[更深]
```

## 中性主题（neutral）

```mermaid
%%{init: {'theme':'neutral'}}%%
sequenceDiagram
    A->>B: neutral 主题
    B-->>A: 回复
```