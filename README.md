# 自建轻量化客服系统

## 项目说明

项目理论上支持debian和乌班图，但目前仅在debian12上测试过

项目对vps的配置要求极低， 1c 512m 的小鸡都能跑起来

安装后在ssh界面输入 chat 回车，可以打开管理面板

本项目仅 readme.md 由本人编写

代码全部由 deekseek 生成，纯ai生成，没有一行代码是手写

项目轻量化无加密，安全可靠无作者恶意埋雷

不放心可以把全部代码文件一次性上传给deepseek审查一遍

个人认为本项目对被害妄想症晚期患者十分友好

目前仅支持对接telegram，因为开发初衷就是为了对接telegram但找不到满意的项目

有其他需求欢迎自行二开



<br>

## 使用说明


### 1. 获取tg机器人的BotToken

@BotFather 新建一个tg机器人，获取机器人的BotToken，类似 1234567890:ABCdefGHIjklmNOPqrstUVwxyz-1234567_A

<br>

### 2. 获取tg群ID

新建一个私有群，将刚才创建的的机器人拉入群中，并给它完整管理员权限

浏览器访问 https://api.telegram.org/bot<你的BotToken>/getUpdates

格式参考 https://api.telegram.org/bot1234567890:ABCdefGHIjklmNOPqrstUVwxyz-1234567_A/getUpdates

自己在群里说一句话，然后看浏览器里显示的内容，其中类似 -888123456 这种格式的数字就是群ID

<br>

### 3. 准备一个域名

#### 如果使用cloudflare：

域名解析vps的ip，开启cloudflare小黄云

去规则里做一个 original rules（源服务器规则）

“主机名”“等于”域名，“目标端口”重写到3000（搭建时默认3000，自己改了就填改的端口）

ssl要开“灵活”


#### 如果不使用cloudflare：

nginx建站，反代 127.0.0.1:3000 

<br>

### 4. 执行安装脚本

```bash
curl -sS -O https://raw.githubusercontent.com/lisi-123/Simplechat-system/main/install.sh && chmod +x install.sh && sudo bash install.sh

```

根据提示填写之前准备好的内容。

<br>
<br>

## 使用方法

网页插入这段代码就能用了，一般放在index.html文件的最末尾就行

```bash
<script
    src="https://你的域名/chat-widget.js"
    data-chat-widget
    defer
></script>
```

v2b机场的小伙伴也可以在主题设置————默认主题————主题设置————自定义页脚HTML 里填写这段代码

<br>

不喜欢折腾可以到此为止，不用往下看！！！

就按照上面的内容就能搭好并正常使用！！！

<br>
<br>

## cf的workers配置

不想直接套小黄云，也可以用workers玩

这里用 example.xyz 举例，实际操作中，请用你的域名替换 example.xyz

子域名中的 ip 和 youxuan 也是举例，都可以自由更换，不要生搬硬套

### 第一步，准备两个子域名

ip.example.xyz：dns解析vps的ip，不开小黄云

youxuan.example.xyz：cname一个cloudflare优选域名，不开小黄云



### 第二步，创建workers

cloudflare账户主页————计算————workers-and-pages————创建一个应用程序————从helloworld开始

创建之后，点进去可以修改配置，把默认配置删掉，填入以下配置

记得将 ip.example.xyz 和 youxuan.example.xyz 修改为自己的域名

```bash
export default {
    async fetch(request) {
        const ORIGIN = "http://ip.example.xyz:3000"; // 需要修改
        const url = new URL(request.url);
        const originUrl = ORIGIN + url.pathname + url.search;
        
        const modifiedRequest = new Request(originUrl, {
            method: request.method,
            headers: request.headers,
            body: request.body
        });
        modifiedRequest.headers.set("X-Forwarded-Host", "youxuan.example.xyz");  // 需要修改
        modifiedRequest.headers.set("X-Forwarded-Proto", "https");
        const response = await fetch(modifiedRequest);
        const modifiedResponse = new Response(response.body, response);
        modifiedResponse.headers.set("Access-Control-Allow-Origin", "*");
        
        return modifiedResponse;
    }
};
```

### 第三步，添加路由

给刚才创建的workers在设置里添加一个路由

区域选择 example.xyz

路由填写 youxuan.example.xyz/*

其他默认即可

<br>


使用过程中有问题直接把代码丢给ai，本人完全不懂代码

<br><br><br>

