import { Plugin, Notice, Editor, MarkdownView, Setting, App, PluginSettingTab } from 'obsidian';
import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { tmpdir } from 'os';

// 插件设置接口
interface AutoUploadImageSettings {
  cfAuthCode: string; // CloudFlare ImgBed的上传认证码
  cfDomain: string; // 图床域名
  cfUploadChannel: string; // 上传渠道
  cfServerCompress: boolean; // 服务端压缩
  cfReturnFormat: string; // 返回链接格式
  cfUploadFolder: string; // 上传目录
  uploadTimeout: number; // 上传超时时间
  webpLossless: boolean; // 是否启用无损WebP转换（核心开关）
}

// 默认设置
const DEFAULT_SETTINGS: AutoUploadImageSettings = {
  cfAuthCode: '',
  cfDomain: 'https://img.966001.xyz',
  cfUploadChannel: 'telegram',
  cfServerCompress: true,
  cfReturnFormat: 'default',
  cfUploadFolder: '',
  uploadTimeout: 15000,
  webpLossless: true // 默认开启无损WebP转换
};

// 上传响应类型定义
interface CFImgBedResponseItem {
  src: string;
}

export default class AutoUploadImagePlugin extends Plugin {
  settings: AutoUploadImageSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AutoUploadImageSettingTab(this.app, this));

    // 监听粘贴事件
    this.registerEvent(
      this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
        await this.handlePaste(evt, editor);
      })
    );

    console.log('自动上传图片插件（无损WebP）已加载');
  }

  onunload() {
    console.log('自动上传图片插件（无损WebP）已卸载');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 处理粘贴事件
  async handlePaste(evt: ClipboardEvent, editor: Editor) {
    if (!this.settings.cfAuthCode) {
      new Notice('请先配置CloudFlare ImgBed的上传认证码！', 5000);
      return;
    }

    const clipboardData = evt.clipboardData;
    if (!clipboardData) return;

    // 1. 处理剪贴板图片
    const items = clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image/') === 0) {
        evt.preventDefault();
        
        const file = item.getAsFile();
        if (file) {
          try {
            // 核心：转换为无损WebP
            const webpFile = await this.convertToLosslessWebP(file);
            // 上传转换后的WebP文件
            const imageUrl = await this.uploadToCFImgBed(webpFile);
            editor.replaceSelection(`![${webpFile.name}](${imageUrl})`);
            new Notice('图片转换为无损WebP并上传成功！', 2000);
            // 清理临时文件
            this.cleanTempFile(webpFile.path);
          } catch (error) {
            new Notice(`处理失败：${(error as Error).message}`, 5000);
            console.error('处理失败：', error);
          }
          return;
        }
      }
    }

    // 2. 处理本地图片路径
    const text = clipboardData.getData('text');
    const localImageRegex = /!\[(.*?)\]\((file:\/\/\/|)([^)]+\.(png|jpg|jpeg|gif|webp))\)/i;
    const match = text.match(localImageRegex);
    if (match) {
      evt.preventDefault();
      const imagePath = match[3].replace(/file:\/\/\//, '');
      try {
        // 读取本地图片并转换为无损WebP
        const webpFile = await this.convertLocalImageToLosslessWebP(imagePath);
        // 上传
        const imageUrl = await this.uploadToCFImgBed(webpFile);
        editor.replaceSelection(`![${webpFile.name}](${imageUrl})`);
        new Notice('本地图片转换为无损WebP并上传成功！', 2000);
        // 清理临时文件
        this.cleanTempFile(webpFile.path);
      } catch (error) {
        new Notice(`处理失败：${(error as Error).message}`, 5000);
        console.error('处理失败：', error);
      }
    }
  }

  /**
   * 将File对象（剪贴板图片）转换为无损WebP格式，返回临时文件信息
   * @param file 原始图片File对象
   * @returns 转换后的WebP临时文件信息
   */
  async convertToLosslessWebP(file: File): Promise<{ name: string; path: string; type: string }> {
    if (!this.settings.webpLossless) {
      // 未开启转换，直接返回原文件
      return {
        name: file.name,
        path: file.path || '',
        type: file.type
      };
    }

    // 生成临时文件路径
    const tempDir = tmpdir();
    const fileName = path.basename(file.name, path.extname(file.name)) + '.webp';
    const tempPath = path.join(tempDir, `obsidian-webp-${Date.now()}-${fileName}`);

    try {
      // 读取图片并转换为无损WebP
      await sharp(await file.arrayBuffer())
        .webp({ lossless: true }) // 核心：无损WebP转换
        .toFile(tempPath);

      return {
        name: fileName,
        path: tempPath,
        type: 'image/webp'
      };
    } catch (error) {
      throw new Error(`图片转换为WebP失败：${(error as Error).message}`);
    }
  }

  /**
   * 将本地图片文件转换为无损WebP格式，返回临时文件信息
   * @param imagePath 本地图片路径
   * @returns 转换后的WebP临时文件信息
   */
  async convertLocalImageToLosslessWebP(imagePath: string): Promise<{ name: string; path: string; type: string }> {
    if (!this.settings.webpLossless) {
      // 未开启转换，直接返回原文件
      return {
        name: path.basename(imagePath),
        path: imagePath,
        type: `image/${path.extname(imagePath).slice(1)}`
      };
    }

    // 生成临时文件路径
    const tempDir = tmpdir();
    const fileName = path.basename(imagePath, path.extname(imagePath)) + '.webp';
    const tempPath = path.join(tempDir, `obsidian-webp-${Date.now()}-${fileName}`);

    try {
      // 读取本地图片并转换为无损WebP
      await sharp(imagePath)
        .webp({ lossless: true }) // 无损转换核心配置
        .toFile(tempPath);

      return {
        name: fileName,
        path: tempPath,
        type: 'image/webp'
      };
    } catch (error) {
      throw new Error(`本地图片转换为WebP失败：${(error as Error).message}`);
    }
  }

  /**
   * 上传图片到CloudFlare ImgBed
   * @param file 待上传的文件（支持原始文件/转换后的WebP文件）
   * @returns 完整图片直链
   */
  async uploadToCFImgBed(file: { name: string; path: string; type: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      // 读取文件流（临时文件/本地文件）
      const fileStream = fs.createReadStream(file.path);
      formData.append('file', fileStream, {
        filename: file.name,
        contentType: file.type
      });

      // 构建Query参数
      const queryParams = new URLSearchParams({
        authCode: this.settings.cfAuthCode,
        serverCompress: String(this.settings.cfServerCompress),
        uploadChannel: this.settings.cfUploadChannel,
        returnFormat: this.settings.cfReturnFormat,
        autoRetry: 'true'
      });
      if (this.settings.cfUploadFolder.trim()) {
        queryParams.append('uploadFolder', this.settings.cfUploadFolder.trim());
      }

      const uploadUrl = `${this.settings.cfDomain}/upload?${queryParams.toString()}`;

      // 发送上传请求
      axios({
        method: 'post',
        url: uploadUrl,
        headers: {
          ...formData.getHeaders(),
          'User-Agent': 'Obsidian-Auto-Upload-Image/1.0.0'
        },
        data: formData,
        timeout: this.settings.uploadTimeout
      }).then((response) => {
        const data = response.data as CFImgBedResponseItem[];
        if (!Array.isArray(data) || !data[0] || !data[0].src) {
          reject(new Error('响应格式错误，未找到图片链接'));
          return;
        }
        const fullImageUrl = `${this.settings.cfDomain}${data[0].src}`;
        resolve(fullImageUrl);
      }).catch((error: AxiosError) => {
        const errorMsg = 
          error.response?.data?.message || 
          error.response?.statusText || 
          error.message || 
          '网络错误，上传失败';
        reject(new Error(errorMsg));
      });
    });
  }

  /**
   * 清理临时文件（避免磁盘占用）
   * @param tempPath 临时文件路径
   */
  cleanTempFile(tempPath: string) {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlink(tempPath, (err) => {
        if (err) console.warn('清理临时WebP文件失败：', err);
      });
    }
  }
}

// 插件设置面板（新增WebP转换开关）
class AutoUploadImageSettingTab extends PluginSettingTab {
  plugin: AutoUploadImagePlugin;

  constructor(app: App, plugin: AutoUploadImagePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '自动上传图片 - CloudFlare ImgBed 配置' });

    // 1. 上传认证码
    new Setting(containerEl)
      .setName('上传认证码（authCode）')
      .setDesc('CloudFlare ImgBed的上传认证码，必填')
      .addText(text => text
        .setValue(this.plugin.settings.cfAuthCode)
        .onChange(async (value) => {
          this.plugin.settings.cfAuthCode = value;
          await this.plugin.saveSettings();
        }));

    // 2. 无损WebP转换开关（核心新增项）
    new Setting(containerEl)
      .setName('启用无损WebP自动转换')
      .setDesc('上传前将图片转换为无损WebP格式，减小体积且不损失质量')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.webpLossless)
        .onChange(async (value) => {
          this.plugin.settings.webpLossless = value;
          await this.plugin.saveSettings();
        }));

    // 3. 图床域名
    new Setting(containerEl)
      .setName('图床域名')
      .setDesc('默认：https://img.966001.xyz')
      .addText(text => text
        .setValue(this.plugin.settings.cfDomain)
        .onChange(async (value) => {
          this.plugin.settings.cfDomain = value;
          await this.plugin.saveSettings();
        }));

    // 4. 上传渠道
    new Setting(containerEl)
      .setName('上传渠道')
      .setDesc('可选值：telegram、cfr2、s3、discord、huggingface')
      .addText(text => text
        .setValue(this.plugin.settings.cfUploadChannel)
        .onChange(async (value) => {
          this.plugin.settings.cfUploadChannel = value;
          await this.plugin.saveSettings();
        }));

    // 5. 上传目录
    new Setting(containerEl)
      .setName('上传目录')
      .setDesc('可选，相对路径，例如：img/test')
      .addText(text => text
        .setValue(this.plugin.settings.cfUploadFolder)
        .onChange(async (value) => {
          this.plugin.settings.cfUploadFolder = value;
          await this.plugin.saveSettings();
        }));

    // 6. 上传超时时间
    new Setting(containerEl)
      .setName('上传超时时间（毫秒）')
      .setDesc('默认15000（15秒）')
      .addText(text => text
        .setValue(String(this.plugin.settings.uploadTimeout))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num)) {
            this.plugin.settings.uploadTimeout = num;
            await this.plugin.saveSettings();
          }
        }));
  }
}