# Bundled theme fonts

These unmodified web fonts supply the files already referenced by the bundled
GitHub, Newsprint and Pixyll theme CSS. They were recovered from the corresponding
font directories in the locally installed Typora 1.9.4 distribution so the
versions and text metrics match the comparison application.

The font binaries' embedded copyright and license URL records were inspected.
Only these redistributable font assets were copied; no application code is used.

| Directory | Font | Embedded license | Accompanying notices |
| --- | --- | --- | --- |
| github | Open Sans v17 (regular, italic, bold, bold italic) | Apache License 2.0 | github/LICENSE-2.0.txt and github/NOTICE.txt |
| newsprint | PT Serif v11 (regular, italic, bold, bold italic) | SIL Open Font License 1.1 | newsprint/OFL.txt |
| pixyll | Merriweather v19 and Lato v14 (four faces each) | SIL Open Font License 1.1 | pixyll/OFL.txt and pixyll/NOTICE.txt |

The OFL texts were obtained from the official theme repository:
https://github.com/typora/typora-default-themes/tree/master/themes

The Apache License text was obtained from:
https://www.apache.org/licenses/LICENSE-2.0.txt

No font files have been modified or renamed. The application embeds their bytes
when loading theme CSS, resolving paths relative to each theme's own directory.
This also makes HTML, PDF and image export independent of installed system fonts
and of network font services for these Latin font families.
